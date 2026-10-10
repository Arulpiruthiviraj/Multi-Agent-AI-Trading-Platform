/**
 * ==========================================================
 * Module: replay/provenance/decisionProvenance
 * ==========================================================
 * POINT-IN-TIME REPLAY PROVENANCE (2026-10-09, certification mission item 1).
 *
 * Closes OCT9_PIT_PROVENANCE_ESCAPE (docs/testing/ARGUS_DEFECT_ESCAPE_REGISTRY.md): before
 * this module, exact point-in-time replay of a Quant decision was impossible — input bar IDs,
 * observed/available-at timestamps, quote timestamps, and StrategyContext inputs were not
 * retained, so a past decision could not be replayed identically and its inputs could not
 * be audited.
 *
 * What this module does (persistence + replay scaffolding only — NO strategy formula or
 * indicator changes; new quant math belongs in quant-core-java/, never here):
 *
 *  1. EMISSION — recordDecisionProvenance() is called on the real paper/quant decision path
 *     (QuantSignalAgent.evaluateSymbolInternal, next to the quant_assessments persist). It
 *     stores one row per decision in `decision_provenance`: input bar IDs + bar timestamps +
 *     per-bar available-at timestamps, the quote used + its observation timestamp, bid/ask
 *     + their observation timestamps, the resolved currentPrice + its observation time, the
 *     bounded+redacted StrategyContext, regime, per-strategy versions (freezeStrategyVersion),
 *     config version, build SHA, lifecycle states at decision time (read-only lookup — a
 *     missing lifecycle row is recorded as-is, NEVER seeded), and the produced
 *     strategyEvaluations + its sha256 fingerprint.
 *
 *  2. LATENCY — the decision path calls recordDecisionProvenance() synchronously but it
 *     never blocks: the public wrapper is a non-throwing fire-and-forget over the async
 *     core persistDecisionProvenance() (single-row better-sqlite3 INSERT, one JSON
 *     stringify of a ~7KB context). A throw or slowdown here can never fail a trading
 *     decision — provenance is telemetry, never a gate.
 *
 *  3. NO-LOOKAHEAD — every input carries data_available_at <= decision_time. Emission
 *     REFUSES to persist a row whose evidence violates this (fail closed, logged loudly);
 *     replayQuantDecision() re-validates on load and THROWS ProvenanceLookaheadViolation
 *     for any hand-inserted or corrupted future-dated row. A replay can never silently
 *     consume data that did not exist at decision time.
 *
 *  4. REPLAY EQUALITY — replayQuantDecision(decisionId) loads the row, validates
 *     no-lookahead, refuses truncated contexts (ProvenanceContextTruncated — an honest
 *     "cannot replay", never fabricated inputs), refuses a build/config mismatch
 *     (ProvenanceVersionMismatch — equality is only claimable on the identical build +
 *     identical strategy-spec config; a different build invalidates the comparison, it
 *     does not silently pass), rebuilds the StrategyContext, and runs the REAL
 *     evaluateAll() from StrategyEngine (the same modules, same call path production
 *     uses — never a reimplementation). It returns equal=true iff the full
 *     StrategyEvaluation arrays match production's persisted output byte-for-byte under
 *     canonical JSON, and the sha256 fingerprints agree.
 *
 *  5. BOUNDEDNESS — per-row byte caps enforced in code (truncate/redact, never unbounded
 *     payloads): strategy context 64KB, evaluations 32KB, whole row 256KB. Per-decision
 *     row cap (8). Retention: sweepDecisionProvenanceRetention in operationalRetention.ts
 *     (registered in RETENTION_SWEEPERS, decisionProvenanceRetentionDays).
 *
 * Determinism note (for the POINT_IN_TIME_REPLAY test): StrategyDefinition.evaluate is
 * contractually pure (same inputs, same output, no I/O, no randomness — see
 * strategies/types.ts), and evaluateAll() is deterministic given (StrategyContext,
 * process env/config, strategy_configurations overlay rows). There is no RNG to seed on
 * this path; the test documents exactly what is asserted equal (full evaluation objects
 * for every evaluated strategy) and the preconditions (identical build SHA + identical
 * strategy-spec config versions).
 *
 * Safety: this module never touches orders, RiskEngine, OMS, BrokerManager, thresholds,
 * lifecycle rows, or LIVE paths. PAPER/telemetry only.
 * ==========================================================
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { sqliteDb } from '../../db';
import { evaluateAll } from '../../quant/strategies/StrategyEngine';
import type { StrategyContext, StrategyEvaluation } from '../../quant/strategies/types';
import { getStrategyLifecycleStatus } from '../../quant/strategies/StrategyEmissionEligibility';
import { freezeStrategyVersion } from '../../research/strategySpecs';

/** Table name — kept as a literal so the retention sweeper and tests share one source. */
export const DECISION_PROVENANCE_TABLE = 'decision_provenance';

/** Byte caps enforced in code (reject/truncate). Sized against measured reality:
 *  a real production StrategyContext JSON is ~7KB, evaluations ~5KB (core) to ~17KB (all 21
 *  strategies live). Bar evidence is ~94B/bar (measured 2026-10-10); the 400-day quant lookback
 *  yields 400-500+ cached 1Day bars, so the bar cap must clear ~47KB — the old 32KB cap refused
 *  97.4% of real decisions in the 2026-10-10 soak. 64KB fits ~680 bars with headroom, and the
 *  256KB whole-row cap below still bounds total row size. */
export const PROVENANCE_STRATEGY_CONTEXT_MAX_BYTES = 64 * 1024;
export const PROVENANCE_EVALUATIONS_MAX_BYTES = 32 * 1024;
export const PROVENANCE_BAR_EVIDENCE_MAX_BYTES = 64 * 1024;
export const PROVENANCE_ROW_MAX_BYTES = 256 * 1024;
/** A traceId should produce exactly one provenance row; the cap is defense-in-depth. */
export const PROVENANCE_MAX_ROWS_PER_DECISION = 8;
/** Redaction: free-text strings longer than this are truncated (numbers are NEVER altered —
 *  altering a number would break replay equality, which is the whole point of the table). */
export const PROVENANCE_MAX_STRING_CHARS = 2048;

// ---------------------------------------------------------------------------
// Error types — replay failures are explicit, never silent.
// ---------------------------------------------------------------------------

export class ProvenanceError extends Error {}
/** An input claims data available AFTER the decision time — the engine REJECTS it. */
export class ProvenanceLookaheadViolation extends ProvenanceError {}
/** No provenance row exists for the requested decision — fail closed, not "assumed". */
export class ProvenanceNotFound extends ProvenanceError {}
/** The stored context was truncated at write time — replay is impossible, stated openly. */
export class ProvenanceContextTruncated extends ProvenanceError {}
/** Build SHA or strategy-spec config differs — equality cannot be claimed across builds. */
export class ProvenanceVersionMismatch extends ProvenanceError {}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** One input bar: its identity, its own timestamp, and when it became observable. */
export interface BarEvidence {
  barId: string; // `${symbol}:${timeframe}:${timestamp}` (ohlcv_bars id format)
  barTimestamp: number; // bar open time, epoch ms
  availableAtMs: number; // when this bar's data was observable (bar close, or fetch time for a provisional bar)
}

export interface ObservedValue {
  price: number | null;
  observedAtMs: number | null;
}

export interface DecisionProvenanceInput {
  decisionId: string; // traceId — matches the quant_assessments row id
  symbol: string;
  timeframe: string;
  decisionTimeMs: number;
  bars: BarEvidence[];
  quote: { price: number | null; observedAtMs: number | null; source: string | null };
  bid: ObservedValue;
  ask: ObservedValue;
  currentPrice: number;
  priceObservedAtMs: number | null;
  /** The REAL StrategyContext evaluateAll() consumed. Bounded + redacted before write. */
  strategyContext: unknown;
  /** The strategyEvaluations array evaluateAll() produced. */
  strategyEvaluations: StrategyEvaluation[];
  /** The decision's subject strategy (resolved best-strategy pick); null when none. */
  strategyId: string | null;
  /** Which producer path wrote this row (e.g. 'QUANT_ENGINE'). */
  dataSource: string;
}

// ---------------------------------------------------------------------------
// Build SHA + versions
// ---------------------------------------------------------------------------

/**
 * The code that computed the decision. ARGUS_BUILD_SHA wins when set (deployed builds may
 * not have a git checkout); otherwise git HEAD; 'unknown' only when neither is available.
 * Computed once per process — a decision and its replay run in the same build.
 */
let cachedBuildSha: string | null = null;
export function resolveBuildSha(): string {
  if (cachedBuildSha) return cachedBuildSha;
  const fromEnv = (process.env.ARGUS_BUILD_SHA ?? '').trim();
  if (fromEnv) {
    cachedBuildSha = fromEnv;
    return cachedBuildSha;
  }
  try {
    cachedBuildSha = execSync('git rev-parse HEAD', {
      cwd: process.cwd(),
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || 'unknown';
  } catch {
    cachedBuildSha = 'unknown';
  }
  return cachedBuildSha;
}

/** For tests only — forces resolveBuildSha() to recompute (e.g. after setting ARGUS_BUILD_SHA). */
export function resetBuildShaCache(): void {
  cachedBuildSha = null;
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

/** Stable stringify: object keys sorted recursively, so semantically-equal payloads hash equal. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Bounding + redaction
// ---------------------------------------------------------------------------

/**
 * Redact unbounded free text WITHOUT touching numbers: any string longer than
 * PROVENANCE_MAX_STRING_CHARS is truncated with a marker. Numbers, booleans, nulls,
 * and short strings pass through untouched — replay equality depends on numeric fidelity.
 */
function redactLongStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > PROVENANCE_MAX_STRING_CHARS
      ? `${value.slice(0, PROVENANCE_MAX_STRING_CHARS)}[truncated ${value.length - PROVENANCE_MAX_STRING_CHARS} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map(redactLongStrings);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactLongStrings(v);
    return out;
  }
  return value;
}

export interface BoundedPayload {
  json: string | null; // null when the payload still exceeds maxBytes after redaction
  truncated: boolean;
  originalBytes: number;
}

/**
 * Enforce the per-payload byte cap: redact long strings, then check the size.
 * Returns json=null (truncated=true) when even the redacted payload exceeds maxBytes —
 * the caller must then either drop the payload (recording the truncation honestly) or
 * reject the row, never silently write an oversized row.
 */
export function boundPayload(value: unknown, maxBytes: number): BoundedPayload {
  const original = JSON.stringify(value) ?? 'null';
  const originalBytes = Buffer.byteLength(original, 'utf8');
  if (originalBytes <= maxBytes) return { json: original, truncated: false, originalBytes };
  const redacted = JSON.stringify(redactLongStrings(value)) ?? 'null';
  const redactedBytes = Buffer.byteLength(redacted, 'utf8');
  if (redactedBytes <= maxBytes) return { json: redacted, truncated: false, originalBytes };
  return { json: null, truncated: true, originalBytes };
}

// ---------------------------------------------------------------------------
// No-lookahead enforcement
// ---------------------------------------------------------------------------

/**
 * Assert every input was available at (or before) decision time. Returns the list of
 * violations (empty = clean). Null observation timestamps are "unavailable data", not a
 * violation — a missing quote cannot be future data.
 */
export function findLookaheadViolations(input: DecisionProvenanceInput): string[] {
  const t = input.decisionTimeMs;
  const violations: string[] = [];
  for (const bar of input.bars) {
    if (bar.availableAtMs > t) {
      violations.push(`bar ${bar.barId}: availableAtMs=${bar.availableAtMs} > decisionTimeMs=${t}`);
    }
  }
  const check = (label: string, observedAtMs: number | null) => {
    if (observedAtMs != null && observedAtMs > t) {
      violations.push(`${label}: observedAtMs=${observedAtMs} > decisionTimeMs=${t}`);
    }
  };
  check('quote', input.quote.observedAtMs);
  check('bid', input.bid.observedAtMs);
  check('ask', input.ask.observedAtMs);
  check('currentPrice', input.priceObservedAtMs);
  return violations;
}

/** Throw ProvenanceLookaheadViolation when any input postdates the decision. */
export function assertNoLookahead(input: DecisionProvenanceInput): void {
  const violations = findLookaheadViolations(input);
  if (violations.length > 0) {
    throw new ProvenanceLookaheadViolation(
      `decision ${input.decisionId} claims input data available after the decision time ` +
        `(${violations.length} violation(s)): ${violations.slice(0, 5).join('; ')}${violations.length > 5 ? '…' : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Bar evidence builder (pure — the decision path calls this, tests assert it)
// ---------------------------------------------------------------------------

/**
 * Build per-bar replay evidence from the bars a decision consumed.
 *
 *  - barId follows the ohlcv_bars id format (`${symbol}:${timeframe}:${timestamp}`) so the
 *    evidence joins back to the stored bars.
 *  - availableAtMs is the honest "when this bar's data was observable": a completed bar is
 *    observable at its close (bar open + duration); the still-forming (provisional) bar is
 *    observable only when it was fetched (observedAtMs). Either way it can never exceed
 *    the observation time, so availableAtMs <= decisionTimeMs holds by construction —
 *    the no-lookahead check then guards against anything that violates it anyway.
 */
export function buildBarEvidence(
  symbol: string,
  timeframe: string,
  bars: Array<{ timestamp: number }>,
  observedAtMs: number,
  barDurationMs: number,
): BarEvidence[] {
  return bars.map((bar) => ({
    barId: `${symbol}:${timeframe}:${bar.timestamp}`,
    barTimestamp: bar.timestamp,
    availableAtMs: Math.min(bar.timestamp + barDurationMs, observedAtMs),
  }));
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

export type PersistProvenanceOutcome =
  | 'written'
  | 'rejected_lookahead'
  | 'rejected_oversize'
  | 'skipped_row_cap';

const insertProvenanceStmt = () =>
  sqliteDb.prepare(
    `INSERT INTO ${DECISION_PROVENANCE_TABLE}
     (id, decision_id, symbol, timeframe, decision_time_ms, bar_evidence_json, quote_json,
      bid_ask_json, current_price, price_observed_at_ms, strategy_context_json, context_truncated,
      regime, strategy_versions_json, config_version, build_sha, lifecycle_states_json,
      strategy_id, evaluations_json, evaluation_fingerprint, data_source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

const countDecisionRowsStmt = () =>
  sqliteDb.prepare(`SELECT COUNT(*) AS n FROM ${DECISION_PROVENANCE_TABLE} WHERE decision_id = ?`);

/**
 * Async core of provenance emission. Never throws — returns an outcome code instead, so the
 * decision path can never be failed by its own telemetry. Fail-closed behaviors:
 *  - lookahead violation → row NOT written ('rejected_lookahead'), logged loudly
 *  - payloads exceed every byte cap → row NOT written ('rejected_oversize'), logged loudly
 *  - per-decision row cap reached → skipped ('skipped_row_cap')
 *
 * Lifecycle states are read-only lookups (getStrategyLifecycleStatus never creates rows);
 * a transient lookup failure records 'LOOKUP_FAILED' for that strategy, never UNTESTED
 * (UNTESTED has real semantics: "no row exists, baseline").
 */
export async function persistDecisionProvenance(input: DecisionProvenanceInput): Promise<PersistProvenanceOutcome> {
  try {
    // 1. No-lookahead is enforced at WRITE time too (defense in depth with the replay-time
    //    check): provenance with impossible timestamps is untrustworthy and must not be stored.
    try {
      assertNoLookahead(input);
    } catch (e) {
      console.error(`[decisionProvenance] REFUSING to persist ${input.decisionId}:`, (e as Error).message);
      return 'rejected_lookahead';
    }

    // 2. Per-decision row cap (defense-in-depth; a traceId should appear exactly once).
    const existing = (countDecisionRowsStmt().get(input.decisionId) as { n: number }).n;
    if (existing >= PROVENANCE_MAX_ROWS_PER_DECISION) {
      console.error(
        `[decisionProvenance] per-decision row cap (${PROVENANCE_MAX_ROWS_PER_DECISION}) reached for ${input.decisionId} — skipping`,
      );
      return 'skipped_row_cap';
    }

    // 3. Byte caps. Strategy context: redact long strings first; if it STILL exceeds the cap
    //    we persist the row with a NULL context + context_truncated=1 rather than dropping the
    //    whole row — the bar/quote/version evidence is still auditable, and replay fails closed
    //    (ProvenanceContextTruncated) instead of fabricating inputs.
    const ctxBound = boundPayload(input.strategyContext, PROVENANCE_STRATEGY_CONTEXT_MAX_BYTES);
    const evalsBound = boundPayload(input.strategyEvaluations, PROVENANCE_EVALUATIONS_MAX_BYTES);
    const barsBound = boundPayload(input.bars, PROVENANCE_BAR_EVIDENCE_MAX_BYTES);
    if (evalsBound.json === null || barsBound.json === null) {
      console.error(
        `[decisionProvenance] REFUSING to persist ${input.decisionId}: evaluations or bar evidence ` +
          `exceed byte caps after redaction (rejected_oversize)`,
      );
      return 'rejected_oversize';
    }
    const evaluationsJson = evalsBound.json;
    const evaluationFingerprint = sha256Hex(stableStringify(input.strategyEvaluations));

    // 4. Strategy versions + config version from the existing freezeStrategyVersion mechanism
    //    (strategy-spec version + spec/config hash). The strategy CODE version is the build
    //    SHA — strategies ship with the build, there is no independent per-module version.
    const strategyVersions: Record<string, string> = {};
    let configVersion: string | null = null;
    for (const ev of input.strategyEvaluations) {
      const frozen = freezeStrategyVersion(ev.strategy);
      strategyVersions[ev.strategy] = frozen?.strategyVersion ?? ev.strategy;
      if (!configVersion && frozen?.configHash) configVersion = frozen.configHash;
    }
    const buildSha = resolveBuildSha();

    // 5. Lifecycle states at decision time — read-only. Bounded to the evaluated strategies;
    //    allSettled so one lookup failure cannot fail the whole row.
    const lifecycleStates: Record<string, string> = {};
    const uniqueIds = [...new Set(input.strategyEvaluations.map((e) => e.strategy))];
    const lookedUp = await Promise.allSettled(uniqueIds.map((id) => getStrategyLifecycleStatus(id)));
    lookedUp.forEach((r, i) => {
      lifecycleStates[uniqueIds[i]] = r.status === 'fulfilled' ? r.value : 'LOOKUP_FAILED';
    });

    const row = {
      id: input.decisionId,
      decisionId: input.decisionId,
      symbol: input.symbol,
      timeframe: input.timeframe,
      decisionTimeMs: input.decisionTimeMs,
      barEvidenceJson: barsBound.json,
      quoteJson: JSON.stringify(input.quote),
      bidAskJson: JSON.stringify({ bid: input.bid, ask: input.ask }),
      currentPrice: input.currentPrice,
      priceObservedAtMs: input.priceObservedAtMs,
      strategyContextJson: ctxBound.json,
      contextTruncated: ctxBound.truncated ? 1 : 0,
      regime: (input.strategyContext as { regime?: { regime?: string } } | null)?.regime?.regime ?? null,
      strategyVersionsJson: JSON.stringify(strategyVersions),
      configVersion,
      buildSha,
      lifecycleStatesJson: JSON.stringify(lifecycleStates),
      strategyId: input.strategyId,
      evaluationsJson,
      evaluationFingerprint,
      dataSource: input.dataSource,
      createdAt: new Date().toISOString(),
    };

    // 6. Whole-row cap: sum the serialized column sizes; reject if the row is still oversized.
    const rowBytes = Buffer.byteLength(
      JSON.stringify([row.barEvidenceJson, row.quoteJson, row.bidAskJson, row.strategyContextJson, row.evaluationsJson]),
      'utf8',
    );
    if (rowBytes > PROVENANCE_ROW_MAX_BYTES) {
      console.error(
        `[decisionProvenance] REFUSING to persist ${input.decisionId}: row ${rowBytes}B exceeds ` +
          `PROVENANCE_ROW_MAX_BYTES=${PROVENANCE_ROW_MAX_BYTES}`,
      );
      return 'rejected_oversize';
    }

    insertProvenanceStmt().run(
      row.id, row.decisionId, row.symbol, row.timeframe, row.decisionTimeMs,
      row.barEvidenceJson, row.quoteJson, row.bidAskJson, row.currentPrice, row.priceObservedAtMs,
      row.strategyContextJson, row.contextTruncated, row.regime, row.strategyVersionsJson,
      row.configVersion, row.buildSha, row.lifecycleStatesJson, row.strategyId,
      row.evaluationsJson, row.evaluationFingerprint, row.dataSource, row.createdAt,
    );
    return 'written';
  } catch (e) {
    // Provenance must never break the decision path: log loudly, report, move on.
    console.error(`[decisionProvenance] persist failed for ${input.decisionId}:`, e instanceof Error ? e.message : String(e));
    return 'rejected_oversize';
  }
}

/**
 * The decision-path entry point. Synchronous, never throws, never awaits: the async core
 * runs fire-and-forget so provenance adds negligible latency and can never block or fail
 * a trading decision. Call it inside the decision path; it is safe to call unconditionally.
 */
export function recordDecisionProvenance(input: DecisionProvenanceInput): void {
  try {
    void persistDecisionProvenance(input).catch((e) => {
      console.error('[decisionProvenance] fire-and-forget persist failed:', e instanceof Error ? e.message : String(e));
    });
  } catch (e) {
    console.error('[decisionProvenance] recordDecisionProvenance threw (must never happen):', e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface StoredProvenanceRow {
  id: string;
  decisionId: string;
  symbol: string;
  timeframe: string;
  decisionTimeMs: number;
  barEvidenceJson: string | null;
  quoteJson: string | null;
  bidAskJson: string | null;
  currentPrice: number | null;
  priceObservedAtMs: number | null;
  strategyContextJson: string | null;
  contextTruncated: boolean;
  regime: string | null;
  strategyVersionsJson: string | null;
  configVersion: string | null;
  buildSha: string | null;
  lifecycleStatesJson: string | null;
  strategyId: string | null;
  evaluationsJson: string | null;
  evaluationFingerprint: string | null;
  dataSource: string | null;
  createdAt: string;
}

const selectProvenanceStmt = () =>
  sqliteDb.prepare(`SELECT * FROM ${DECISION_PROVENANCE_TABLE} WHERE decision_id = ? ORDER BY created_at ASC LIMIT 1`);

/**
 * Raw better-sqlite3 rows carry the physical snake_case column names (drizzle's camelCase
 * mapping does not apply to direct sqliteDb queries) — map once, here, so the rest of this
 * module works in camelCase. A wrong name here would read undefined and fail closed in
 * exactly the wrong place, so this mapping is explicit and complete.
 */
function mapProvenanceRow(raw: Record<string, unknown>): StoredProvenanceRow {
  return {
    id: String(raw.id),
    decisionId: String(raw.decision_id),
    symbol: String(raw.symbol),
    timeframe: String(raw.timeframe),
    decisionTimeMs: Number(raw.decision_time_ms),
    barEvidenceJson: (raw.bar_evidence_json as string | null) ?? null,
    quoteJson: (raw.quote_json as string | null) ?? null,
    bidAskJson: (raw.bid_ask_json as string | null) ?? null,
    currentPrice: raw.current_price == null ? null : Number(raw.current_price),
    priceObservedAtMs: raw.price_observed_at_ms == null ? null : Number(raw.price_observed_at_ms),
    strategyContextJson: (raw.strategy_context_json as string | null) ?? null,
    contextTruncated: Number(raw.context_truncated) === 1,
    regime: (raw.regime as string | null) ?? null,
    strategyVersionsJson: (raw.strategy_versions_json as string | null) ?? null,
    configVersion: (raw.config_version as string | null) ?? null,
    buildSha: (raw.build_sha as string | null) ?? null,
    lifecycleStatesJson: (raw.lifecycle_states_json as string | null) ?? null,
    strategyId: (raw.strategy_id as string | null) ?? null,
    evaluationsJson: (raw.evaluations_json as string | null) ?? null,
    evaluationFingerprint: (raw.evaluation_fingerprint as string | null) ?? null,
    dataSource: (raw.data_source as string | null) ?? null,
    createdAt: String(raw.created_at),
  };
}

/**
 * Load a provenance row for replay. Validates, fail-closed:
 *  - no row → ProvenanceNotFound
 *  - any input with data_available_at > decision_time → ProvenanceLookaheadViolation
 *    (the engine REJECTS future-dated provenance, even if it was hand-inserted)
 *  - context truncated at write time → ProvenanceContextTruncated
 */
export async function loadProvenanceForReplay(decisionId: string): Promise<StoredProvenanceRow> {
  const raw = selectProvenanceStmt().get(decisionId) as Record<string, unknown> | undefined;
  if (!raw) {
    throw new ProvenanceNotFound(`no decision_provenance row for decision ${decisionId} — replay impossible, failing closed`);
  }
  const row = mapProvenanceRow(raw);
  // Re-validate no-lookahead on the STORED evidence (defense in depth: a row could have
  // been inserted by hand or by an older build without write-time enforcement).
  const bars: BarEvidence[] = row.barEvidenceJson ? (JSON.parse(row.barEvidenceJson) as BarEvidence[]) : [];
  const quote = row.quoteJson ? (JSON.parse(row.quoteJson) as DecisionProvenanceInput['quote']) : { price: null, observedAtMs: null, source: null };
  const bidAsk = row.bidAskJson
    ? (JSON.parse(row.bidAskJson) as { bid: ObservedValue; ask: ObservedValue })
    : { bid: { price: null, observedAtMs: null }, ask: { price: null, observedAtMs: null } };
  const violations = findLookaheadViolations({
    decisionId: row.decisionId,
    symbol: row.symbol,
    timeframe: row.timeframe,
    decisionTimeMs: row.decisionTimeMs,
    bars,
    quote,
    bid: bidAsk.bid,
    ask: bidAsk.ask,
    currentPrice: row.currentPrice ?? NaN,
    priceObservedAtMs: row.priceObservedAtMs,
    strategyContext: null,
    strategyEvaluations: [],
    strategyId: row.strategyId,
    dataSource: row.dataSource ?? 'UNKNOWN',
  });
  if (violations.length > 0) {
    throw new ProvenanceLookaheadViolation(
      `stored provenance for ${decisionId} claims input data available after the decision time — REJECTED: ` +
        `${violations.slice(0, 5).join('; ')}${violations.length > 5 ? '…' : ''}`,
    );
  }
  if (row.contextTruncated || !row.strategyContextJson) {
    throw new ProvenanceContextTruncated(
      `stored provenance for ${decisionId} has a truncated/missing strategy context — replay is impossible, failing closed rather than fabricating inputs`,
    );
  }
  return row;
}

export interface ReplayResult {
  decisionId: string;
  /** true iff replay(evaluateAll) == production evaluations, byte-for-byte under canonical JSON. */
  equal: boolean;
  /** The evaluations exactly as production persisted them. */
  productionEvaluations: StrategyEvaluation[];
  /** The evaluations the replay computed through the REAL evaluateAll() path. */
  replayEvaluations: StrategyEvaluation[];
  buildSha: string;
  strategyVersions: Record<string, string>;
  /** Human-readable mismatch descriptions (empty when equal). */
  mismatches: string[];
}

/**
 * Independent replay of a past Quant decision through the REAL strategy evaluation path.
 *
 * "Independent": the replay reconstructs its StrategyContext solely from what was persisted
 * (through a real SQLite read + JSON.parse — never the in-memory object production used),
 * then calls the same evaluateAll() production calls. Equality is asserted as:
 *   stableStringify(replayEvaluations) === stableStringify(productionEvaluations)
 *   AND sha256(replay) === stored evaluationFingerprint === sha256(production)
 *
 * Preconditions (fail closed, never silently compared):
 *  - build SHA must match the row's build_sha (a different build = different code =
 *    equality is meaningless; the comparison is invalid, not "failed")
 *  - per-strategy versions from freezeStrategyVersion must match the row's recorded
 *    versions (strategy-spec/config drift invalidates the comparison)
 *
 * Throws: ProvenanceNotFound | ProvenanceLookaheadViolation | ProvenanceContextTruncated |
 * ProvenanceVersionMismatch. Never returns a fabricated "equal" on missing data.
 */
export async function replayQuantDecision(decisionId: string): Promise<ReplayResult> {
  const row = await loadProvenanceForReplay(decisionId);

  const currentBuildSha = resolveBuildSha();
  if (row.buildSha !== currentBuildSha) {
    throw new ProvenanceVersionMismatch(
      `cannot replay ${decisionId}: recorded build_sha=${row.buildSha} != current build ${currentBuildSha} — ` +
        `replay equality is only claimable on the identical build; a different build invalidates the comparison`,
    );
  }

  const recordedVersions: Record<string, string> = row.strategyVersionsJson
    ? (JSON.parse(row.strategyVersionsJson) as Record<string, string>)
    : {};
  const currentVersions: Record<string, string> = {};
  const productionEvaluations = (row.evaluationsJson ? JSON.parse(row.evaluationsJson) : []) as StrategyEvaluation[];
  const versionMismatches: string[] = [];
  for (const ev of productionEvaluations) {
    const frozen = freezeStrategyVersion(ev.strategy);
    currentVersions[ev.strategy] = frozen?.strategyVersion ?? ev.strategy;
    if (recordedVersions[ev.strategy] !== undefined && recordedVersions[ev.strategy] !== currentVersions[ev.strategy]) {
      versionMismatches.push(
        `strategy ${ev.strategy}: recorded version ${recordedVersions[ev.strategy]} != current ${currentVersions[ev.strategy]}`,
      );
    }
  }
  if (versionMismatches.length > 0) {
    throw new ProvenanceVersionMismatch(
      `cannot replay ${decisionId}: strategy version drift — ${versionMismatches.join('; ')}`,
    );
  }

  // The independent reconstruction: from persisted JSON only.
  const strategyContext = JSON.parse(row.strategyContextJson as string) as StrategyContext;

  // THE real evaluation path — StrategyEngine.evaluateAll, the same function and the same
  // strategy modules production called. Not a reimplementation, not a stub.
  const replayEvaluations = evaluateAll(strategyContext);

  const productionCanonical = stableStringify(productionEvaluations);
  const replayCanonical = stableStringify(replayEvaluations);
  const mismatches: string[] = [];
  if (productionCanonical !== replayCanonical) {
    mismatches.push('canonical evaluation JSON differs between production and replay');
    // Per-strategy detail so a mismatch is diagnosable, not just a boolean.
    const byId = (list: StrategyEvaluation[]) => new Map(list.map((e) => [e.strategy, e]));
    const prodMap = byId(productionEvaluations);
    const replayMap = byId(replayEvaluations);
    for (const [id, prod] of prodMap) {
      const rep = replayMap.get(id);
      if (!rep) {
        mismatches.push(`strategy ${id}: present in production, missing in replay`);
      } else if (stableStringify(prod) !== stableStringify(rep)) {
        mismatches.push(`strategy ${id}: evaluation differs (side ${prod.side}/${rep.side}, confidence ${prod.confidence}/${rep.confidence}, setupScore ${prod.setupScore}/${rep.setupScore})`);
      }
    }
    for (const id of replayMap.keys()) {
      if (!prodMap.has(id)) mismatches.push(`strategy ${id}: present in replay, missing in production`);
    }
  }
  const replayFingerprint = sha256Hex(replayCanonical);
  if (row.evaluationFingerprint && row.evaluationFingerprint !== replayFingerprint) {
    mismatches.push('replay fingerprint does not match the persisted evaluation_fingerprint');
  }
  // Belt-and-braces: the persisted fingerprint must also match the persisted evaluations
  // (detects a corrupted row, not just a replay divergence).
  if (row.evaluationFingerprint && sha256Hex(productionCanonical) !== row.evaluationFingerprint) {
    mismatches.push('persisted evaluation_fingerprint does not match the persisted evaluations (row corruption)');
  }

  return {
    decisionId,
    equal: mismatches.length === 0,
    productionEvaluations,
    replayEvaluations,
    buildSha: currentBuildSha,
    strategyVersions: currentVersions,
    mismatches,
  };
}

/**
 * Retention sweeper for decision_provenance — batched + yielding like every other sweeper
 * in operationalRetention.ts (large backlogs must never block the event loop), never throws.
 * Prunes by created_at (ISO text, chronological). Kept in this module next to the table's
 * other logic; registered in RETENTION_SWEEPERS.
 */
export async function sweepDecisionProvenanceRetention(nowMs = Date.now()): Promise<number> {
  const { runtimeIntervals } = await import('../../config/runtimeIntervals');
  const cutoffIso = new Date(nowMs - runtimeIntervals.decisionProvenanceRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const batchSize = runtimeIntervals.newsRetentionSweepBatchSize;
  const maxBatches = runtimeIntervals.newsRetentionSweepMaxBatchesPerCall;
  let totalDeleted = 0;
  try {
    // Prepared INSIDE the try: better-sqlite3 throws synchronously on prepare() when the
    // table is missing (e.g. a stale isolated copy), and the sweeper contract is "never
    // throws, returns a partial count" — a persistently failing sweep must be loud (the
    // console.error below), not a crash.
    const deleteBatch = sqliteDb.prepare(
      `DELETE FROM ${DECISION_PROVENANCE_TABLE} WHERE id IN (SELECT id FROM ${DECISION_PROVENANCE_TABLE} WHERE created_at < ? LIMIT ?)`,
    );
    for (let i = 0; i < maxBatches; i++) {
      const result = deleteBatch.run(cutoffIso, batchSize);
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return totalDeleted;
  } catch (e) {
    console.error('[decisionProvenance] sweepDecisionProvenanceRetention failed:', e instanceof Error ? e.message : String(e));
    return totalDeleted;
  }
}
