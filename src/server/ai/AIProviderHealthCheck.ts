/**
 * AI Provider Health Check - three tiers, per the operator's own design:
 *   1. CONFIG   (cheap, no network): is a provider selected, is a credential present and not a
 *      placeholder, is a model configured.
 *   2. AUTH     (real, minimal network request): provider.authenticate() + a tiny "Reply with
 *      exactly: OK" chat call - the exact same probe AIRouter.probeProviderAtStartup() already
 *      runs once at boot, made re-runnable on demand/periodically and classified into a named
 *      status instead of a binary healthy/not.
 *   3. RUNTIME  (tracked over time): last success/failure, consecutive failures, latency - kept in
 *      a small in-memory map owned entirely by this module, updated only by this module's own
 *      checks (startup / periodic / on-demand). Deliberately does NOT hook into AIRouter's live
 *      routeTask()/routeConsensus() call sites - keeps this additive and isolated, and means a
 *      trading agent's own AI call timing/volume never skews this diagnostic's cadence.
 *
 * Zero-Trade Forensic Audit finding this addresses: "Configured: check" was being treated as
 * "healthy" nowhere in code, but there was also no single place that told an operator WHICH
 * provider was actually broken and WHY (auth vs quota vs timeout vs model-not-found) without
 * reading raw ai_calls error strings by hand. This module exists to make that distinction explicit
 * and queryable - it does not change routing, does not change consensus math, and never places or
 * blocks a trade by itself.
 *
 * Never logs, stores, or returns a raw API key - only booleans/classifications derived from the
 * same envKeyForProviderName()/isPlaceholderApiKey() helpers AIRouter.ts already uses.
 */
import { AIRouter, envKeyForProviderName, isPlaceholderApiKey, isAuthFailureError, isUnreachableProviderError, isTimeoutSkipError } from './AIRouter';
import type { AIProvider } from './providers/AIProvider';
import { db } from '../db';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../core/EncryptionService';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { createSingleFlightGuard } from '../core/singleFlightInterval';

export type AIProviderHealthStatus =
  | 'HEALTHY'
  | 'AUTH_FAILED'
  | 'CONFIG_MISSING'
  | 'PROVIDER_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'ACCOUNT_SUSPENDED'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface AIProviderHealthRecord {
  providerId: string;
  providerName: string;
  configured: boolean;
  credentialPresent: boolean;
  /** OPS-1: which credential this provider is actually running on right now - never the value.
   *  'ENV' covers both "no DB key was ever stored" and "DB key was stale and AIRouter's startup
   *  probe already fell back to .env" - see AIRouter.getCredentialSource()'s own doc comment. */
  credentialSource: 'DB' | 'ENV' | 'NONE';
  model: string | null;
  registered: boolean;
  authenticated: boolean;
  status: AIProviderHealthStatus;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  /** Sanitized (SecretRedaction-style) message - never the raw key. */
  lastErrorSummary: string | null;
}

interface TrackerEntry {
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  lastStatus: AIProviderHealthStatus;
  lastErrorSummary: string | null;
}

const tracker = new Map<string, TrackerEntry>();
let intervalId: ReturnType<typeof setInterval> | null = null;
// Real gap found and fixed (2026-09-15, post-forensic-audit timer sweep): each tick() runs a REAL
// paid auth+chat-completion probe against EVERY configured provider (Promise.all over
// checkProviderHealth calls). With no guard, a slow/hung provider on one tick could still be
// in-flight when the next 180s tick fires, doubling real API spend to every OTHER (already-healthy)
// provider too, and racing two concurrent read-modify-writes of the same tracker Map entries
// (consecutiveFailures etc). Same reusable guard every other periodic worker already uses.
const tickGuard = createSingleFlightGuard((e) => console.error('[AIProviderHealthCheck] tick failed', e));

function emptyEntry(): TrackerEntry {
  return {
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastLatencyMs: null,
    lastStatus: 'UNKNOWN',
    lastErrorSummary: null,
  };
}

/** Never the raw key - just enough to distinguish failure classes in logs/UI. */
function sanitizeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[?&]?api[_-]?key=[^&\s]+/gi, '[REDACTED]').slice(0, 300);
}

/** Additive to AIRouter's own isAuthFailureError/isUnreachableProviderError/isTimeoutSkipError -
 *  those three already exist and are reused verbatim; this adds the remaining distinctions the
 *  operator asked for (quota vs rate-limit vs model-not-found vs generic unreachable). */
export function classifyError(err: unknown): AIProviderHealthStatus {
  const msg = err instanceof Error ? err.message : String(err);
  if (isTimeoutSkipError(err)) return 'TIMEOUT';
  // Real fix (2026-08-24 readiness audit, Part 5, corrected 2026-08-25): "account suspended" is a
  // real, distinct failure mode (seen live from Moonshot/Kimi - "account ... is suspended due to
  // insufficient balance"). This must be checked BEFORE isAuthFailureError(), not just before the
  // quota/rate-limit patterns below - isAuthFailureError()'s own `\b401\b` pattern matches the raw
  // HTTP status embedded in the same thrown message (providers construct errors as
  // `${status} ${statusText}${bodySnippet}`), so whenever Moonshot happens to return the suspended
  // account's error as HTTP 401 (rather than 429/402, which it also does, inconsistently, for the
  // exact same underlying condition), the generic 401 match fired first and silently masked this
  // more specific, more actionable diagnosis - confirmed live this session: a direct probe with
  // the real key got a clean 429 "suspended" body, while Argus's own classification had
  // (before this fix) inconsistently shown AUTH_FAILED depending on which status code Moonshot's
  // API returned for that same probe. The account-suspended check is now unconditionally first,
  // so the classification depends only on the response body, never on which status code an
  // upstream provider's flaky error-code choice happens to attach to it.
  if (/suspend(ed)?/i.test(msg) && /insufficient|balance|recharge/i.test(msg)) return 'ACCOUNT_SUSPENDED';
  if (isAuthFailureError(err)) return 'AUTH_FAILED';
  if (/\b402\b|payment required|quota|insufficient[_ ]?quota|billing/i.test(msg)) return 'QUOTA_EXCEEDED';
  if (/\b429\b|rate[_ -]?limit/i.test(msg)) return 'RATE_LIMITED';
  if (/\b404\b/.test(msg) && /model/i.test(msg)) return 'MODEL_UNAVAILABLE';
  // Real gap found (Phase 9 Friday forensic audit, 2026-08-28): NVIDIA logged 676 real "410 Gone"
  // failures that day alone, matching none of the classifiers above or below - noteProviderSkipFromError
  // armed no cooldown at all, so the provider was retried on every single call, all day. Unlike a
  // bare 404 (too generic/common for transient causes - typo'd URL, momentary routing issue - to
  // treat as a permanent quarantine on its own), HTTP 410 is a deliberate, unambiguous "this
  // resource is permanently gone" signal per the HTTP spec - no corroborating "model" keyword
  // required. Classified the same as MODEL_UNAVAILABLE so it gets the same long,
  // does-not-self-heal-within-a-session cooldown, not the short transient one.
  if (/\b410\b/.test(msg)) return 'MODEL_UNAVAILABLE';
  if (isUnreachableProviderError(err)) return 'PROVIDER_UNAVAILABLE';
  return 'UNKNOWN';
}

type HealthCheckOutcome =
  | { ok: true; latencyMs: number }
  | { ok: false; status: AIProviderHealthStatus; errorSummary: string };

function recordResult(providerId: string, outcome: HealthCheckOutcome): void {
  const entry = tracker.get(providerId) ?? emptyEntry();
  const now = Date.now();
  entry.lastCheckedAt = now;
  if (outcome.ok === false) {
    entry.lastFailureAt = now;
    entry.consecutiveFailures += 1;
    entry.lastStatus = outcome.status;
    entry.lastErrorSummary = outcome.errorSummary;
  } else {
    entry.lastSuccessAt = now;
    entry.consecutiveFailures = 0;
    entry.lastLatencyMs = outcome.latencyMs;
    entry.lastStatus = 'HEALTHY';
    entry.lastErrorSummary = null;
  }
  tracker.set(providerId, entry);
}

/** Real, minimal network request - same shape as AIRouter's own probeProviderAtStartup(), made
 *  re-runnable. Never throws - a failed check is a recorded status, not an exception. */
export async function checkProviderHealth(providerId: string, provider: AIProvider): Promise<void> {
  const start = Date.now();
  try {
    const authed = await provider.authenticate();
    if (!authed) {
      recordResult(providerId, { ok: false, status: 'AUTH_FAILED', errorSummary: 'authenticate() returned false' });
      return;
    }
    const controller = new AbortController();
    const timeoutMs = 8000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await provider.chat('Reply with exactly: OK', { temperature: 0, signal: controller.signal });
      clearTimeout(timer);
      if (!res.content) {
        recordResult(providerId, { ok: false, status: 'UNKNOWN', errorSummary: 'empty response content' });
        return;
      }
      recordResult(providerId, { ok: true, latencyMs: Date.now() - start });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  } catch (e) {
    recordResult(providerId, { ok: false, status: classifyError(e), errorSummary: sanitizeErrorMessage(e) });
  }
}

/** On-demand trigger (the operator's "Test Provider" button) - runs the real AUTH-tier check now
 *  for one provider (or every currently-registered provider) and returns the refreshed snapshot. */
export async function runAIProviderHealthCheckNow(providerId?: string): Promise<AIProviderHealthRecord[]> {
  const entries = AIRouter.getInstance().listProviders();
  const targets = providerId ? entries.filter(([id]) => id === providerId) : entries;
  await Promise.all(targets.map(([id, provider]) => checkProviderHealth(id, provider)));
  return await getAIProviderHealthSnapshot();
}

/** CONFIG + AUTH + RUNTIME merged into one honest per-provider record. Covers every DB-known
 *  provider row, not just currently-registered ones, so a provider that failed to even register
 *  (e.g. missing credential) still shows up as CONFIG_MISSING rather than silently disappearing.
 *  Always reads DB rows fresh (same per-request cost AIRouter.routeTask/routeConsensus already
 *  pay) rather than depending on the periodic monitor having ticked at least once first. */
export async function getAIProviderHealthSnapshot(): Promise<AIProviderHealthRecord[]> {
  let rows: (typeof schema.aiProviders.$inferSelect)[] = [];
  try {
    rows = await db.select().from(schema.aiProviders);
  } catch {
    return [];
  }
  const registered = new Map(AIRouter.getInstance().listProviders());
  const records: AIProviderHealthRecord[] = [];
  for (const row of rows) {
    let credentialPresent = false;
    try {
      const decrypted = row.apiKeyEncrypted ? EncryptionService.decrypt(row.apiKeyEncrypted) : envKeyForProviderName(row.providerName);
      credentialPresent = !isPlaceholderApiKey(decrypted);
    } catch {
      // DB key present but undecryptable (e.g. ENCRYPTION_SECRET was rotated) —
      // fall back to the env key instead of reporting the provider unconfigured.
      // The env file is a supported credential source (see envKeyForProviderName).
      try {
        credentialPresent = !isPlaceholderApiKey(envKeyForProviderName(row.providerName));
      } catch {
        credentialPresent = false;
      }
    }
    const endpointHint = row.apiEndpoint || '';
    const isLocal = endpointHint.includes('localhost') || endpointHint.includes('127.0.0.1');
    const configured = row.enabled !== false && (isLocal || credentialPresent);
    const isRegistered = registered.has(row.id);
    const t = tracker.get(row.id);

    let status: AIProviderHealthStatus;
    if (!configured) {
      status = 'CONFIG_MISSING';
    } else if (!isRegistered) {
      status = 'PROVIDER_UNAVAILABLE';
    } else if (t) {
      status = t.lastStatus;
    } else {
      status = 'UNKNOWN'; // configured + registered, but no check has run yet this process
    }

    records.push({
      providerId: row.id,
      providerName: row.providerName,
      configured,
      credentialPresent: isLocal || credentialPresent,
      credentialSource: AIRouter.getInstance().getCredentialSource(row.id),
      model: row.defaultModel ?? null,
      registered: isRegistered,
      authenticated: status === 'HEALTHY',
      status,
      latencyMs: t?.lastLatencyMs ?? null,
      lastCheckedAt: t?.lastCheckedAt ? new Date(t.lastCheckedAt).toISOString() : null,
      lastSuccessAt: t?.lastSuccessAt ? new Date(t.lastSuccessAt).toISOString() : (row.lastSuccess ?? null),
      lastFailureAt: t?.lastFailureAt ? new Date(t.lastFailureAt).toISOString() : (row.lastFailure ?? null),
      consecutiveFailures: t?.consecutiveFailures ?? 0,
      lastErrorSummary: t?.lastErrorSummary ?? null,
    });
  }
  return records;
}

/** Startup + periodic. Safe to call multiple times (idempotent no-op if already running). Runs
 *  one immediate check (the "startup" tier) before scheduling the periodic tier. */
export function startAIProviderHealthMonitor(): void {
  if (intervalId) return;
  void tickGuard.run(tick);
  intervalId = setInterval(() => { void tickGuard.run(tick); }, runtimeIntervals.aiProviderHealthCheckMs);
}

/** Test/ops observability for the single-flight coalescing above. */
export function getAIProviderHealthTickGuardMetrics() {
  return tickGuard.getMetrics();
}

export function stopAIProviderHealthMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * A1 (2026-10-08): sticky-Offline quarantine recovery.
 *
 * Defect this closes: aiProviders.health='Offline' had no recovery path. The writers
 * (AIRouter.disableProviderForAuthFailure and the routeTask()/routeConsensus() failure
 * branches, which quarantine via successRate decaying below 50) are real failure accounting,
 * but the readers (routeTask/routeConsensus's `isKnownDead` filter) then permanently exclude
 * an Offline provider whenever any live provider remains - and the only writer back to a
 * routable health was a *successful routed call*, which that same exclusion made unreachable.
 * The periodic health probe ran real checks every tick yet wrote only to an in-memory tracker,
 * never to aiProviders.health. Net effect: one transient outage (or one auth failure, which
 * writes health='Offline' with only an in-memory 5-minute routing cooldown) permanently
 * removed the provider until manual DB surgery.
 *
 * Recovery contract (fail-closed at every step):
 *  - Only rows currently health='Offline' are eligible; anything else is a no-op.
 *  - An operator-disabled row (enabled=false) is never resurrected, even to 'Degraded'.
 *  - The quarantine must have aged at least aiProviderQuarantineCooldownMs, measured from
 *    the row's last_failure (the moment it last earned an Offline write). A missing or
 *    unparseable last_failure fails closed - we cannot prove the cooldown elapsed.
 *  - Only a REAL successful re-probe restores. A failed (or never-run) probe keeps the
 *    provider Offline. The caller (tick()) passes whether this tick's own checkProviderHealth
 *    probe succeeded, so recovery is always grounded in fresh evidence, never inference.
 *  - Restore is deliberately conservative: health='Degraded' re-enters routing (only
 *    'Offline' is excluded by the known-dead filter) but stays below 'Healthy' in sort
 *    priority, and successRate is lifted just above the 50 quarantine line so the restored
 *    row honors the existing "health='Offline' <=> successRate<50" write-time invariant.
 *    The organic +/-1/-5 successRate math then governs from there - sustained real failures
 *    re-quarantine, real successes promote to 'Healthy'.
 *  - This is a health-state restore only. It never marks strategies VALIDATED/CHAMPION
 *    (a separate lifecycle), never changes consensus thresholds, and never touches
 *    RiskEngine/OMS/BrokerManager.
 */
export async function maybeRecoverQuarantinedProvider(
  providerId: string,
  probeSucceeded: boolean,
  nowMs: number = Date.now(),
): Promise<'restored' | 'kept-offline' | 'not-quarantined'> {
  let rows: (typeof schema.aiProviders.$inferSelect)[];
  try {
    rows = await db.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, providerId));
  } catch (e) {
    // A DB read failure is "cannot prove healthy" - fail closed, quarantine stands.
    console.error(`[AIProviderHealthCheck] quarantine recovery: DB read failed for ${providerId} - kept Offline`, e);
    return 'kept-offline';
  }
  const row = rows?.[0];
  if (!row || row.health !== 'Offline') return 'not-quarantined';
  if (row.enabled === false) {
    // Operator intent wins over automatic recovery: a disabled provider stays out of
    // rotation regardless of probe results.
    return 'kept-offline';
  }
  const quarantinedAtMs = row.lastFailure ? Date.parse(row.lastFailure) : NaN;
  if (!Number.isFinite(quarantinedAtMs)) {
    console.warn(`[AIProviderHealthCheck] quarantine recovery: ${providerId} is Offline with no parseable last_failure - kept Offline (fail-closed)`);
    return 'kept-offline';
  }
  if (nowMs - quarantinedAtMs < runtimeIntervals.aiProviderQuarantineCooldownMs) return 'kept-offline';
  // Fail closed: a failed re-probe keeps the provider Offline. No decay, no half-credit.
  if (!probeSucceeded) return 'kept-offline';
  const restoredRate = Math.max(51, row.successRate ?? 0);
  try {
    await db.update(schema.aiProviders).set({
      health: 'Degraded',
      successRate: restoredRate,
      lastSuccess: new Date(nowMs).toISOString(),
    }).where(eq(schema.aiProviders.id, providerId));
  } catch (e) {
    console.error(`[AIProviderHealthCheck] quarantine recovery: DB write failed for ${providerId} - kept Offline`, e);
    return 'kept-offline';
  }
  console.log(
    `[AIProviderHealthCheck] Provider ${providerId} passed quarantine re-probe after ` +
    `${Math.round((nowMs - quarantinedAtMs) / 60000)}min Offline - health Offline -> Degraded ` +
    `(successRate ${restoredRate}). Sustained real failures will re-quarantine via the -5/failure math.`,
  );
  return 'restored';
}

/** Whether this tick's own checkProviderHealth probe for the provider succeeded. recordResult()
 *  stamps lastCheckedAt on every probe and lastSuccessAt only on success, both from the same
 *  Date.now() - so equality + recency means "this tick's probe just succeeded", not a stale
 *  success from an earlier tick. */
function wasProbeSuccessfulThisTick(providerId: string, tickStartMs: number): boolean {
  const entry = tracker.get(providerId);
  return !!entry
    && entry.lastCheckedAt !== null
    && entry.lastCheckedAt >= tickStartMs
    && entry.lastSuccessAt === entry.lastCheckedAt;
}

async function tick(): Promise<void> {
  const tickStartMs = Date.now();
  const entries = AIRouter.getInstance().listProviders();
  await Promise.all(entries.map(([id, provider]) => checkProviderHealth(id, provider)));
  // A1 (2026-10-08): give quarantined providers a real, time-decayed path back. Each provider
  // that just passed this tick's real probe gets exactly one recovery evaluation per tick;
  // maybeRecoverQuarantinedProvider() is fail-closed on every other axis (cooldown, disabled
  // rows, failed probes, DB errors).
  for (const [id] of entries) {
    await maybeRecoverQuarantinedProvider(id, wasProbeSuccessfulThisTick(id, tickStartMs), Date.now());
  }
  // Drop tracker entries for providers that are no longer registered (removed or
  // reconfigured under a new id). getAIProviderHealthSnapshot() only ever looks
  // up DB rows, so a stale entry for a gone provider is never surfaced - without
  // this it would accumulate forever as provider rows churn.
  pruneAIProviderHealthTracker();
}

/**
 * Remove in-memory health-tracker entries for provider ids that are no longer
 * registered on AIRouter. Called by the periodic tick(); exported so tests can
 * prove stale entries are actually dropped. Pure cleanup: it never changes what
 * getAIProviderHealthSnapshot() reports for any still-known provider.
 */
export function pruneAIProviderHealthTracker(): void {
  const registered = new Set(AIRouter.getInstance().listProviders().map(([id]) => id));
  for (const id of tracker.keys()) {
    if (!registered.has(id)) tracker.delete(id);
  }
}

/** Test-only - clears in-memory tracker without touching AIRouter's own state. */
export function resetAIProviderHealthTrackerForTests(): void {
  tracker.clear();
  stopAIProviderHealthMonitor();
}
