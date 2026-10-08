/**
 * ==========================================================
 * Module:
 * AiAdvisoryService.ts
 *
 * Purpose:
 * Event-driven, advisory-only AI wiring for the Argus quant-first
 * architecture (2026-10-07, Phase-40 "AI value" channel). Routes MATERIAL
 * EVENTS — never ticks, quotes, or scans — to the AI call governor
 * (src/server/ai/AICallGovernor.ts) for an optional Jev triage/advisory pass.
 *
 * Hard contract (provably non-gating):
 * - Every public method is synchronous fire-and-forget and NEVER throws.
 * - Nothing here is awaited by, or can delay, any trading decision.
 * - Results are observability + an in-memory advisory note cache ONLY.
 *   No trading code path reads these results to decide anything.
 * - The in-memory note is passed into QuantExecutionPolicy as an
 *   advisory-only input: it is recorded on the decision and never
 *   consulted by any check (see QuantExecutionPolicy's AI-advisory block).
 *
 * Governor contract (sibling-owned, LANDED 2026-10-07):
 *   AICallGovernor.getInstance().request<T>({
 *     capability: 'STRUCTURED_DECISION',
 *     kind,                                   // 'news_catalyst_triage' | 'quant_candidate_advisory'
 *     material: { symbol?, fingerprintParts, materiality: 'HIGH'|'MEDIUM'|'LOW',
 *                 decisionDeadlineMs, traceId? },
 *     jev: { state, questions, schemaVersion },
 *     run,                                    // required by type; never invoked for STRUCTURED_DECISION
 *   }) -> { status: 'CALLED', result, latencyMs }
 *         | { status: 'CACHE_HIT', result }
 *         | { status: 'SKIPPED', reason, detail }
 *         | { status: 'FAILED', error, kind }
 * The governor is resolved lazily (dynamic import) and is INJECTABLE for
 * tests. If resolution fails, every consideration degrades to a silent no-op.
 *
 * Never:
 * - Import BrokerManager / OrderManagementService / RiskEngine.
 * - Emit CHIEF_APPROVED_IDEA or any trade idea.
 * - Log JEV_API_KEY (the service never even reads it — the governor owns auth).
 * ==========================================================
 */

import type { JevAnswer, JevQuestion } from './providers/JevProvider';
import type { GovernorRequestOpts, GovernorResult } from './AICallGovernor';
import type { JevDecisionResult } from './JevDecisionProvider';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

/** Structural governor contract — satisfied by the sibling's AICallGovernor. */
export interface AIGovernorLike {
  request<T>(opts: GovernorRequestOpts<T>): Promise<GovernorResult<T>>;
}

export interface NewsCatalystArticle {
  id: string;
  symbol: string;
  title: string;
  summary: string;
  publishedAt: number;
}

export interface QuantCandidateContext {
  strategyId: string;
  side: string;
  traceId: string;
}

const NEWS_TRIAGE_KIND = 'news_catalyst_triage';
const QUANT_ADVISORY_KIND = 'quant_candidate_advisory';
/** Schema version stamped on every JevCallSpec this service builds. */
const ADVISORY_SCHEMA_VERSION = 'ai-advisory-service/1';

/** In-memory advisory-note cache: TTL 120s, max 200 entries, oldest evicted first. */
const ADVISORY_NOTE_TTL_MS = 120_000;
const ADVISORY_NOTE_MAX_ENTRIES = 200;
/** Fingerprint memory cap for duplicate suppression (insertion-ordered). */
const SEEN_FINGERPRINT_MAX = 5_000;

interface AdvisoryNoteEntry {
  note: string;
  expiresAt: number;
}

/** Bounded, insertion-ordered fingerprint memory for duplicate suppression. */
class FingerprintMemory {
  private seen = new Set<string>();
  has(fp: string): boolean {
    return this.seen.has(fp);
  }
  add(fp: string): void {
    if (this.seen.size >= SEEN_FINGERPRINT_MAX) {
      // Evict oldest ~10% — keeps memory bounded without per-add scans.
      let n = Math.floor(SEEN_FINGERPRINT_MAX / 10);
      for (const oldest of this.seen) {
        this.seen.delete(oldest);
        if (--n <= 0) break;
      }
    }
    this.seen.add(fp);
  }
  clear(): void {
    this.seen.clear();
  }
}

export class AiAdvisoryService {
  private static instance: AiAdvisoryService | null = null;

  private injectedGovernor: AIGovernorLike | null = null;
  private resolvedGovernor: AIGovernorLike | null | undefined = undefined;
  private noteCache = new Map<string, AdvisoryNoteEntry>();
  private fingerprints = new FingerprintMemory();
  private pending = new Set<Promise<void>>();

  private constructor() {}

  public static getInstance(): AiAdvisoryService {
    if (!AiAdvisoryService.instance) {
      AiAdvisoryService.instance = new AiAdvisoryService();
    }
    return AiAdvisoryService.instance;
  }

  /** Test seam: inject a mock governor. Pass null to restore lazy resolution. */
  public setGovernorForTesting(governor: AIGovernorLike | null): void {
    this.injectedGovernor = governor;
  }

  /** Test seam: clear governor override, cache, fingerprints, and pending work. */
  public resetForTesting(): void {
    this.injectedGovernor = null;
    this.resolvedGovernor = undefined;
    this.noteCache.clear();
    this.fingerprints.clear();
    this.pending.clear();
  }

  /**
   * Test seam: await all in-flight advisory work. Production callers never use
   * this — fire-and-forget is the whole point.
   */
  public async drainPendingAdvisoryWork(): Promise<void> {
    try {
      const work = Array.from(this.pending);
      this.pending.clear();
      await Promise.all(work);
    } catch {
      // Never rejects by contract.
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — all synchronous, fire-and-forget, never throws.
  // ---------------------------------------------------------------------------

  /**
   * Consider a genuinely-new news article for Jev catalyst triage. Callers must
   * invoke this only at a dedup point (new articles, never duplicates/polls).
   * Builds ONE Jev request with 4 batched questions. Never throws.
   */
  public considerNewsCatalyst(article: NewsCatalystArticle): void {
    try {
      const symbol = (article?.symbol || '').trim().toUpperCase();
      const articleId = (article?.id || '').trim();
      if (!symbol || !articleId) return;
      const fingerprint = `news:${symbol}:${articleId}`;
      // Single consideration path per article: duplicates are suppressed here
      // even if a caller misses its own dedup point (the governor's own
      // singleflight/cooldown is a second, independent layer).
      if (this.fingerprints.has(fingerprint)) return;
      this.fingerprints.add(fingerprint);
      this.track(this.runNewsCatalystTriage({ ...article, symbol, id: articleId }, fingerprint));
    } catch {
      // Never throws into the caller.
    }
  }

  /**
   * Consider a quant candidate for post-decision AI advisory context. MUST be
   * called only AFTER the quant policy decision is fully recorded — never
   * before/during. Result goes to observability only. Never throws.
   */
  public considerQuantCandidateAdvisory(symbol: string, ctx: QuantCandidateContext): void {
    try {
      const sym = (symbol || '').trim().toUpperCase();
      const traceId = (ctx?.traceId || '').trim();
      if (!sym || !traceId) return;
      this.track(this.runQuantCandidateAdvisory(sym, ctx, traceId));
    } catch {
      // Never throws into the caller.
    }
  }

  /**
   * Synchronous in-memory advisory-note read. Pure lookup: no I/O, no governor
   * contact, never throws. Returns null when absent or expired.
   */
  public getAdvisoryNote(symbol: string): string | null {
    try {
      const sym = (symbol || '').trim().toUpperCase();
      if (!sym) return null;
      const entry = this.noteCache.get(sym);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        this.noteCache.delete(sym);
        return null;
      }
      return entry.note;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals — every async path is catch-all guarded.
  // ---------------------------------------------------------------------------

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => {
      this.pending.delete(work);
    });
  }

  private async resolveGovernor(): Promise<AIGovernorLike | null> {
    if (this.injectedGovernor) return this.injectedGovernor;
    if (this.resolvedGovernor !== undefined) return this.resolvedGovernor;
    try {
      // Lazy: the governor module is only loaded when advisory work actually runs.
      const mod = (await import('./AICallGovernor')) as {
        AICallGovernor?: { getInstance?: () => unknown };
      };
      const getInstance = mod?.AICallGovernor?.getInstance;
      const governor =
        typeof getInstance === 'function' && typeof (getInstance() as { request?: unknown })?.request === 'function'
          ? (getInstance() as AIGovernorLike)
          : null;
      this.resolvedGovernor = governor;
      return governor;
    } catch {
      this.resolvedGovernor = null;
      return null;
    }
  }

  /**
   * `run` is required by GovernorRequestOpts but never invoked for
   * STRUCTURED_DECISION (the governor builds the Jev request itself — see
   * AICallGovernor.invokeJev). Fail-closed if ever misrouted.
   */
  private unusedRun(): GovernorRequestOpts<JevDecisionResult>['run'] {
    return async () => {
      throw new Error('[AiAdvisoryService] run is never invoked for STRUCTURED_DECISION');
    };
  }

  private async runNewsCatalystTriage(article: NewsCatalystArticle, fingerprint: string): Promise<void> {
    try {
      const governor = await this.resolveGovernor();
      if (!governor) {
        this.debug('ai_advisory_no_governor', NEWS_TRIAGE_KIND, article.symbol, 'governor unavailable');
        return;
      }
      const now = Date.now();
      const result = await governor.request<JevDecisionResult>({
        capability: 'STRUCTURED_DECISION',
        kind: NEWS_TRIAGE_KIND,
        material: {
          symbol: article.symbol,
          fingerprintParts: { articleId: article.id, symbol: article.symbol },
          materiality: 'HIGH',
          decisionDeadlineMs: now + 60_000,
        },
        jev: {
          state: {
            symbol: article.symbol,
            title: article.title,
            summary: article.summary,
            publishedAt: new Date(article.publishedAt).toISOString(),
          },
          questions: buildNewsTriageQuestions(article.symbol),
          schemaVersion: ADVISORY_SCHEMA_VERSION,
        },
        run: this.unusedRun(),
      });
      if (result.status === 'CALLED' || result.status === 'CACHE_HIT') {
        const payload = result.result;
        const parsed = parseNewsTriageAnswers(payload?.answers);
        observeSafe(() => {
          structuredLogger.info('ai_advisory_news_catalyst', {
            category: 'AI',
            eventType: 'AI_ADVISORY_NEWS_CATALYST',
            symbol: article.symbol,
            outcome: result.status,
            articleId: article.id,
            fingerprint,
            model: payload?.model,
            latencyMs: result.status === 'CALLED' ? result.latencyMs : payload?.latencyMs,
            inputTokens: payload?.inputTokens,
            relevant: parsed.relevant,
            catalystType: parsed.catalystType,
            materiality: parsed.materiality,
            needsDeeperResearch: parsed.needsDeeperResearch,
          });
        }, 'ai-advisory');
        this.storeNote(article.symbol, buildNewsTriageNote(article.symbol, result.status, parsed));
      } else if (result.status === 'SKIPPED') {
        this.debug('ai_advisory_skipped', NEWS_TRIAGE_KIND, article.symbol, `${result.reason}: ${result.detail}`);
      } else {
        this.debug('ai_advisory_failed', NEWS_TRIAGE_KIND, article.symbol, `${result.kind}`);
      }
    } catch {
      // Advisory work never throws out of the service.
    }
  }

  private async runQuantCandidateAdvisory(
    symbol: string,
    ctx: QuantCandidateContext,
    traceId: string,
  ): Promise<void> {
    try {
      const governor = await this.resolveGovernor();
      if (!governor) {
        this.debug('ai_advisory_no_governor', QUANT_ADVISORY_KIND, symbol, 'governor unavailable');
        return;
      }
      const now = Date.now();
      const result = await governor.request<JevDecisionResult>({
        capability: 'STRUCTURED_DECISION',
        kind: QUANT_ADVISORY_KIND,
        material: {
          symbol,
          fingerprintParts: { traceId, symbol },
          materiality: 'MEDIUM',
          decisionDeadlineMs: now + 60_000,
          traceId,
        },
        jev: {
          state: {
            symbol,
            strategyId: ctx.strategyId,
            side: ctx.side,
            traceId,
          },
          questions: {
            thesis_supported: {
              type: 'noul',
              instructions:
                `Does the available context support the quant strategy's thesis for ${symbol} ` +
                `(${ctx.strategyId}, side ${ctx.side})? Answer yes when the context is consistent ` +
                `with the thesis, no when it contradicts or undermines it.`,
            },
            material_risk_event: {
              type: 'noul',
              instructions:
                `Is there a material risk event in the available context for ${symbol} ` +
                `(halt, delisting, fraud allegation, major regulatory action, extreme volatility ` +
                `event) that a human reviewer should know about alongside this quant candidate?`,
            },
          },
          schemaVersion: ADVISORY_SCHEMA_VERSION,
        },
        run: this.unusedRun(),
      });
      if (result.status === 'CALLED' || result.status === 'CACHE_HIT') {
        const payload = result.result;
        const thesis = asProbability(payload?.answers?.['thesis_supported']);
        const risk = asProbability(payload?.answers?.['material_risk_event']);
        // Observability ONLY — the decision this annotates is already recorded.
        observeSafe(() => {
          structuredLogger.info('ai_advisory_quant_candidate', {
            category: 'AI',
            eventType: 'AI_ADVISORY_QUANT_CANDIDATE',
            symbol,
            traceId,
            strategyId: ctx.strategyId,
            side: ctx.side,
            outcome: result.status,
            model: payload?.model,
            latencyMs: result.status === 'CALLED' ? result.latencyMs : payload?.latencyMs,
            inputTokens: payload?.inputTokens,
            thesisSupported: thesis,
            materialRiskEvent: risk,
          });
        }, 'ai-advisory');
      } else if (result.status === 'SKIPPED') {
        this.debug('ai_advisory_skipped', QUANT_ADVISORY_KIND, symbol, `${result.reason}: ${result.detail}`);
      } else {
        this.debug('ai_advisory_failed', QUANT_ADVISORY_KIND, symbol, `${result.kind}`);
      }
    } catch {
      // Advisory work never throws out of the service.
    }
  }

  private storeNote(symbol: string, note: string): void {
    const trimmed = note.length > 400 ? note.slice(0, 397) + '...' : note;
    if (this.noteCache.size >= ADVISORY_NOTE_MAX_ENTRIES) {
      // Evict oldest (Map preserves insertion order).
      const oldest = this.noteCache.keys().next();
      if (!oldest.done) this.noteCache.delete(oldest.value);
    }
    this.noteCache.set(symbol, { note: trimmed, expiresAt: Date.now() + ADVISORY_NOTE_TTL_MS });
  }

  private debug(message: string, kind: string, symbol: string, detail: string): void {
    observeSafe(() => {
      structuredLogger.debug(message, {
        category: 'AI',
        eventType: 'AI_ADVISORY_DEBUG',
        symbol,
        kind,
        detail,
      });
    }, 'ai-advisory');
  }
}

export interface ParsedNewsTriage {
  relevant: number | null;
  catalystType: string | null;
  materiality: number | null;
  needsDeeperResearch: number | null;
}

function buildNewsTriageQuestions(symbol: string): Record<string, JevQuestion> {
  return {
    relevant: {
      type: 'noul',
      instructions:
        `Is this news article materially relevant to the listed company ${symbol}? ` +
        `Answer yes only if the article is actually about ${symbol} or its direct business ` +
        `(earnings, products, management, regulation affecting it). Answer no for passing ` +
        `mentions, sector roundups where the company is incidental, or unrelated stories.`,
    },
    catalyst_type: {
      type: 'choice',
      instructions: `Classify the primary catalyst type of this news for ${symbol}.`,
      criteria: {
        earnings: 'Quarterly/annual results, earnings calls, EPS surprises',
        guidance: 'Forward guidance, outlook revisions, forecasts',
        regulatory: 'Regulatory action, approvals, investigations, legislation',
        macro: 'Macroeconomic news (rates, inflation, employment) affecting the company',
        product: 'Product launches, recalls, partnerships, M&A',
        legal: 'Lawsuits, settlements, legal rulings',
        analyst: 'Analyst ratings or price-target changes',
        other: 'None of the above',
      },
    },
    materiality: {
      type: 'score',
      instructions: `Rate how material this news is for ${symbol}'s near-term price action.`,
      criteria: [
        '1 - negligible: no plausible price impact',
        '2 - minor: small, likely transient impact',
        '3 - moderate: could move the stock several percent',
        '4 - high: likely significant multi-percent move',
        '5 - critical: thesis-changing event',
      ],
    },
    needs_deeper_research: {
      type: 'noul',
      instructions:
        `Would a deeper research pass (full filings, multiple sources) be warranted for ` +
        `${symbol} on this story before forming any view?`,
    },
  };
}

function asProbability(answer: JevAnswer | undefined): number | null {
  if (answer && answer.type === 'noul' && typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
    return answer.noul;
  }
  return null;
}

function parseNewsTriageAnswers(answers: Record<string, JevAnswer> | undefined): ParsedNewsTriage {
  const catalyst = answers?.['catalyst_type'];
  const materiality = answers?.['materiality'];
  return {
    relevant: asProbability(answers?.['relevant']),
    catalystType:
      catalyst && catalyst.type === 'choice' && typeof catalyst.choice === 'string'
        ? catalyst.choice
        : null,
    materiality:
      materiality && materiality.type === 'score' && typeof materiality.score === 'number' && Number.isFinite(materiality.score)
        ? materiality.score
        : null,
    needsDeeperResearch: asProbability(answers?.['needs_deeper_research']),
  };
}

function fmtProb(p: number | null): string {
  return p == null ? 'n/a' : `p=${p.toFixed(2)}`;
}

function buildNewsTriageNote(
  symbol: string,
  status: 'CALLED' | 'CACHE_HIT',
  parsed: ParsedNewsTriage,
): string {
  const research =
    parsed.needsDeeperResearch == null ? 'n/a' : parsed.needsDeeperResearch >= 0.5 ? 'yes' : 'no';
  return (
    `[AI advisory · ${symbol}] Jev triage (${status}): relevant ${fmtProb(parsed.relevant)}; ` +
    `catalyst=${parsed.catalystType ?? 'n/a'}; materiality=${parsed.materiality ?? 'n/a'}/5; ` +
    `deeper research: ${research}. Advisory only — never gates trading.`
  );
}

export const aiAdvisoryService = AiAdvisoryService.getInstance();
