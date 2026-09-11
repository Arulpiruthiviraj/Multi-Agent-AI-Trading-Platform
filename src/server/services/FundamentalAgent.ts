/**
 * ==========================================================
 * Module: FundamentalAgent.ts
 *
 * Purpose:
 * Evaluates real fundamental data if available.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { AIRouter } from '../ai/AIRouter';
import { ExternalDataCache, looksLikeRateLimitResponse, hashObject } from './ExternalDataCache';
import { AlphaVantageBudget } from './AlphaVantageBudget';
import { FmpBudget } from './FmpBudget';
import { coerceEnum, normalizeConfidence01, coerceString, parseJsonFromLlmContent, TRADE_SIDE_VALUES } from '../ai/AIOutputValidator';
import { logErrorSafely } from '../core/SecretRedaction';
import { generateTraceId } from '../core/traceId';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { networkEndpoints } from '../config/networkEndpoints';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { marketDataWorker } from './MarketDataWorker';
import { waitForFreshMarketData } from '../core/waitForFreshMarketData';
import { selectPriorityRoundRobinSymbol } from '../core/agentRoundRobin';
import { getRecentCandidates } from '../core/recentCandidateRegistry';
import { tradingSafety } from '../config/tradingSafety';
import {
  notePipelineAgentFailure,
  notePipelineAgentGated,
  notePipelineAgentSuccess,
  notePipelineAgentTick,
} from '../core/pipelineAgentHealth';

const UNKNOWN_FUNDAMENTALS = { peRatio: 'UNKNOWN', epsGrowth: 'UNKNOWN', debtToEquity: 'UNKNOWN' };
// Fundamentals (P/E, EPS growth, debt/equity) are quarterly-cadence data in reality - refetching
// every 60s was never going to see new information, only burn a 25-req/day quota shared across
// 3 symbols and MacroAgent. 24h is generous relative to how often this data actually changes.
const FUNDAMENTALS_CACHE_MAX_AGE_MS = runtimeIntervals.fundamentalsCacheMaxAgeMs;

// Hardening pass, Phase 7: the 24h cache above only ever gated the raw AlphaVantage fetch - every
// 60s tick that hit a cache HIT for the raw data still went on to call the real, paid Gemini API
// again with the exact same input, real ongoing cost waste for a decision that couldn't possibly
// have changed. Cache key includes the agent, a hash of the exact data the LLM was given, and a
// prompt-version tag (bump AI_ANALYSIS_PROMPT_VERSION whenever the prompt text below changes, to
// invalidate every previously-cached analysis rather than silently reusing an answer to a
// different question) - so a cache hit only reuses an analysis for byte-for-byte identical real
// input, and a fresh AlphaVantage fetch that returns materially different numbers automatically
// misses the cache and gets a fresh, real LLM call. Never outlives the raw-data cache itself.
const AI_ANALYSIS_PROMPT_VERSION = 'v1';
const AI_ANALYSIS_CACHE_MAX_AGE_MS = FUNDAMENTALS_CACHE_MAX_AGE_MS;

interface CachedAnalysis { recommendation: string; confidence: number; reasoning: string; }

export class FundamentalAnalysisAgent {
  private intervalId: NodeJS.Timeout | null = null;
  private inFlight = false;
  /** Set at the top of every analyzeFundamentals() tick, before any gate check - proves the
   * setInterval callback itself is still firing, independent of whether Autobot/the pipeline
   * toggle currently allows it to emit an idea. A stale value with the interval supposedly
   * running is the signal a hung shared dependency (e.g. AlphaVantageBudget) has wedged this
   * agent silently. */
  public lastTickAt: number | null = null;

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => { void this.tickSafely(); }, runtimeIntervals.fundamentalAgentMs);
    void this.tickSafely();
  }

  private async tickSafely(): Promise<void> {
    if (this.inFlight) {
      this.lastTickAt = Date.now();
      notePipelineAgentTick('FundamentalAgent');
      return;
    }
    this.inFlight = true;
    try {
      await this.analyzeFundamentals();
    } catch (e) {
      notePipelineAgentFailure('FundamentalAgent', e);
      logErrorSafely('[FundamentalAgent] Tick failed (interval continues):', e);
    } finally {
      this.inFlight = false;
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Free fallback fundamentals provider (2026-09-10, real AlphaVantage-daily-cap-exhaustion
   * finding: 228 real DATA_UNAVAILABLE HOLDs from FundamentalAgent in one session, 2026-09-10
   * morning). Financial Modeling Prep's free tier (250 req/day, no payment - see
   * fmpDailyRequestBudget in config/tradingSafety.json) is only ever attempted AFTER AlphaVantage
   * has already given up for this symbol (no stale cache, budget exhausted/rate-limited/absent) -
   * never the primary source, never competes with AlphaVantageBudget's own accounting. Returns
   * null (never a fabricated value) when FMP isn't configured, has no budget left, or its own
   * response doesn't contain real data - the caller falls through to the existing honest
   * RATE_LIMITED/UNKNOWN HOLD in that case exactly as before this fallback existed.
   */
  private async tryFmpFallback(symbol: string): Promise<typeof UNKNOWN_FUNDAMENTALS | null> {
    if (!process.env.FMP_API_KEY) return null;
    if (!(await FmpBudget.tryConsume(1))) return null;
    try {
      const response = await fetch(`${networkEndpoints.marketData.fmpBaseUrl}/ratios-ttm/${symbol}?apikey=${process.env.FMP_API_KEY}`);
      if (!response.ok) return null;
      const rows = await response.json() as any;
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return null;
      const peRatio = row.peRatioTTM ?? row.priceEarningsRatioTTM ?? null;
      const debtToEquity = row.debtEquityRatioTTM ?? row.debtToEquityTTM ?? null;
      if (peRatio == null && debtToEquity == null) return null;

      let epsGrowth = 'UNKNOWN';
      try {
        const growthRes = await fetch(`${networkEndpoints.marketData.fmpBaseUrl}/income-statement-growth/${symbol}?limit=1&apikey=${process.env.FMP_API_KEY}`);
        if (growthRes.ok) {
          const growthRows = await growthRes.json() as any;
          const growthRow = Array.isArray(growthRows) ? growthRows[0] : null;
          if (growthRow?.growthEPS != null) epsGrowth = String(growthRow.growthEPS);
        }
      } catch {
        // Best-effort only - a missing growth figure does not invalidate the real peRatio/debtToEquity above.
      }

      const result = {
        peRatio: peRatio ?? 'UNKNOWN',
        epsGrowth,
        debtToEquity: debtToEquity ?? 'UNKNOWN',
      };
      // Cached under its own provider namespace, never conflated with AlphaVantage's cache row -
      // a later AlphaVantage recovery must not be shadowed by a stale FMP fallback result.
      await ExternalDataCache.set('fmp', 'fundamentals', symbol, result);
      console.warn(`[FundamentalAgent] AlphaVantage unavailable for ${symbol} — served real fundamentals from FMP fallback.`);
      return result;
    } catch (e) {
      logErrorSafely('[FundamentalAgent] FMP fallback fetch failed:', e);
      return null;
    }
  }

  private async fetchFundamentalsGiveUp(symbol: string, warnPrefix: string): Promise<typeof UNKNOWN_FUNDAMENTALS> {
    const stale = await ExternalDataCache.getStale<typeof UNKNOWN_FUNDAMENTALS>('alphavantage', 'fundamentals', symbol);
    if (stale) {
      console.warn(`[FundamentalAgent] ${warnPrefix} for ${symbol} — serving cached fundamentals.`);
      return stale;
    }
    const fmp = await this.tryFmpFallback(symbol);
    if (fmp) return fmp;
    return { peRatio: 'RATE_LIMITED', epsGrowth: 'RATE_LIMITED', debtToEquity: 'RATE_LIMITED' };
  }

  private async fetchFundamentals(symbol: string) {
    if (!process.env.ALPHAVANTAGE_API_KEY) {
      const fmp = await this.tryFmpFallback(symbol);
      return fmp ?? UNKNOWN_FUNDAMENTALS;
    }

    const cached = await ExternalDataCache.getFresh<typeof UNKNOWN_FUNDAMENTALS>('alphavantage', 'fundamentals', symbol, FUNDAMENTALS_CACHE_MAX_AGE_MS);
    if (cached) return cached;

    if (await ExternalDataCache.isRateLimited('alphavantage', 'fundamentals', symbol)) {
      return this.fetchFundamentalsGiveUp(symbol, 'AlphaVantage backoff active');
    }

    if (!(await AlphaVantageBudget.tryConsume(1, undefined, 'FundamentalAgent'))) {
      return this.fetchFundamentalsGiveUp(symbol, 'AlphaVantage daily budget exhausted');
    }

    try {
      const response = await fetch(`${networkEndpoints.marketData.alphaVantageBaseUrl}?function=OVERVIEW&symbol=${symbol}&apikey=${process.env.ALPHAVANTAGE_API_KEY}`);
      if (response.status === 429) {
        console.warn(`[FundamentalAgent] AlphaVantage rate limit hit for ${symbol} - backing off for 24h.`);
        await ExternalDataCache.markRateLimited('alphavantage', 'fundamentals', symbol);
        return this.fetchFundamentalsGiveUp(symbol, 'AlphaVantage HTTP 429');
      }
      const data = await response.json() as any;

      if (looksLikeRateLimitResponse(data)) {
        console.warn(`[FundamentalAgent] AlphaVantage rate limit hit for ${symbol} - backing off for 24h.`);
        await ExternalDataCache.markRateLimited('alphavantage', 'fundamentals', symbol);
        return this.fetchFundamentalsGiveUp(symbol, 'AlphaVantage rate-limit body');
      }

      if (data && data.PERatio) {
        const result = {
          peRatio: data.PERatio,
          epsGrowth: data.QuarterlyEarningsGrowthYOY || 'UNKNOWN',
          debtToEquity: data.DebtToEquity || 'UNKNOWN',
        };
        await ExternalDataCache.set('alphavantage', 'fundamentals', symbol, result);
        return result;
      }
    } catch (e) {
      // AlphaVantage's API only supports key-in-query-string auth - see SecretRedaction.ts.
      logErrorSafely('[FundamentalAgent] AlphaVantage fetch failed:', e);
    }

    const fmp = await this.tryFmpFallback(symbol);
    return fmp ?? UNKNOWN_FUNDAMENTALS;
  }

  // currentPrice is optional here (a HOLD's price_validity relevance is moot either way), but
  // attaching it whenever known keeps every emitted idea self-describing rather than depending on
  // gateTradeIdea's separate lookupLivePrice fallback registration.
  private emitHold(traceId: string, symbol: string, reasoning: string, currentPrice?: number | null): void {
    eventBus.emitTradeIdea({
      traceId,
      symbol,
      side: 'HOLD',
      confidence: 0,
      reasoning,
      agent: 'FundamentalAgent',
      currentPrice: currentPrice ?? undefined,
    });
  }

  async analyzeFundamentals() {
    this.lastTickAt = Date.now();
    notePipelineAgentTick('FundamentalAgent');
    if (!isLiveIdeaGenerationEnabled()) {
      notePipelineAgentGated('FundamentalAgent');
      return;
    }
    if (!isPipelineAgentEnabled('FundamentalAgent')) {
      notePipelineAgentGated('FundamentalAgent');
      return;
    }
    const universe = resolveIdeaUniverse();
    if (universe.length === 0) {
      notePipelineAgentGated('FundamentalAgent');
      return;
    }
    // Phase 7F (2026-08-27): prioritize symbols with a real, fresh tick (same stalePriceThresholdMs
    // RiskEngine's data_freshness gate already uses) over the full active-subscription set - a
    // blind round-robin over every active symbol gave a quiet anchor with zero ticks the same
    // priority as a symbol TechnicalAgent/QuantEngine are actively producing real ideas for right
    // now, diluting per-symbol coverage further as the active set grows through the session.
    const freshSymbols = universe.filter((s) => {
      const age = marketDataWorker.getLatestPriceAgeMs(s);
      return age !== null && age <= tradingSafety.stalePriceThresholdMs;
    });
    // Phase 9 (same-candidate convergence): prefer a symbol ConfluenceCoordinator recently found
    // worth a reactive Quant/Kronos re-check (a real qualifying TechnicalAgent signal), when it is
    // ALSO still fresh - never invents a candidate, just narrows the priority pool when a genuine
    // recent one exists. Falls back to the plain freshSymbols set exactly as before otherwise.
    const recentCandidates = getRecentCandidates(tradingSafety.recentCandidatePriorityMaxAgeMs).filter((s) => freshSymbols.includes(s));
    const priorityPool = recentCandidates.length > 0 ? recentCandidates : freshSymbols;
    const symbol = selectPriorityRoundRobinSymbol(universe, priorityPool, runtimeIntervals.fundamentalAgentMs, Date.now());
    await this.evaluateSymbol(symbol);
  }

  /**
   * Phase 9 (same-candidate convergence, 2026-08-27): extracted from analyzeFundamentals() so
   * ConfluenceCoordinator can request an on-demand evaluation for a specific real candidate symbol
   * (the same on-demand pattern already used for QuantEngine/KronosEngine), instead of only ever
   * waiting for this agent's own round-robin to land on it up to fundamentalAgentMs later. Every
   * gate/cache/budget check below is identical and still applies regardless of caller - an
   * on-demand call that has no real budget left, or whose data isn't fresh, gets the exact same
   * fail-closed DATA_UNAVAILABLE HOLD the scheduled path would. Re-checks the safety gate itself
   * (not just relying on the scheduled caller having already checked it) so this can never become
   * a way to bypass Autobot-off/interrupted-session holds via the on-demand path.
   */
  async evaluateSymbol(symbol: string): Promise<void> {
    if (!isLiveIdeaGenerationEnabled() || !isPipelineAgentEnabled('FundamentalAgent')) return;

    const traceId = generateTraceId(symbol);
    // Original fix (2026-08-24 readiness audit, Part 2): request coverage for the evaluation
    // target instead of passively hoping it happened to already be streamed. subscribe() is
    // idempotent/cap-aware (MarketDataWorker.ts) and improves the odds this symbol has a real
    // tick the *next* time it comes up - it does not help THIS tick, since a fresh subscription
    // has no tick yet at the moment it's requested.
    //
    // Completed fix (2026-09-06 remediation, docs/audits/ARGUS_CURRENT_STATE_AND_PAPER_READINESS_AUDIT.md
    // §26/§30 finding R3): the 2026-09-03 NewsEngine fix for this identical structural bug
    // (NewsEngine.ts's own comment at its matching call site) was explicitly NOT extended here at
    // the time - confirmed live via real DB query: FundamentalAgent became the dominant MISSING_PRICE
    // source (203 of 09-03's 366 rejections) the moment NewsEngine's share collapsed, with MacroAgent
    // as the other major source. Applying the identical, already-reviewed fix here: a bounded,
    // allocator-aware wait for a real fresh tick (waitForFreshMarketData.ts, same
    // requestTemporaryDataRescue() path every other rescue caller uses) instead of a raw
    // subscribe()+immediate-read. ROUTINE_RECOVERY is the correct request class here (a scheduled
    // round-robin re-evaluation, not a news catalyst or exploration candidate) - per the same
    // audit's own capacity data, ROUTINE_RECOVERY/RENEWAL requests see ~0% denial, so this should
    // resolve cleanly in the common case and fail closed (never fabricate a price) otherwise.
    eventBus.emit(EVENTS.PRICE_SNAPSHOT_REQUESTED, { symbol, requestedBy: 'FundamentalAgent', at: new Date().toISOString() });
    marketDataWorker.subscribe(symbol, { requestedBy: 'FundamentalAgent' });
    const freshData = await waitForFreshMarketData(symbol, {
      requestClass: 'ROUTINE_RECOVERY',
      reason: 'FundamentalAgent_awaiting_fresh_price',
      traceId,
    });
    if (freshData.ok === false) {
      const reasoning = freshData.reason === 'RESCUE_DENIED'
        ? `DATA_UNAVAILABLE: market-data rescue denied for ${symbol} (${freshData.deniedReason}). No fabricated price emitted.`
        : freshData.reason === 'ERROR'
        ? `DATA_UNAVAILABLE: fresh-data wait errored for ${symbol} (${freshData.detail}). No fabricated price emitted.`
        : `DATA_UNAVAILABLE: no fresh tick arrived for ${symbol} within ${tradingSafety.newsPriceWaitTimeoutMs}ms. No fabricated price emitted.`;
      this.emitHold(traceId, symbol, reasoning, null);
      notePipelineAgentSuccess('FundamentalAgent');
      return;
    }
    // Same authoritative live-price source gateTradeIdea's own lookupLivePrice fallback already
    // reads (MarketDataWorker's WS tick cache) - now a real, confirmed-fresh tick, never invented.
    const currentPrice = freshData.price;

    try {
       const data = await this.fetchFundamentals(symbol);

       if (data.peRatio === "RATE_LIMITED") {
          this.emitHold(traceId, symbol, "DATA_UNAVAILABLE: AlphaVantage daily rate limit exhausted - real data resumes after a 24h cooldown.", currentPrice);
          notePipelineAgentSuccess('FundamentalAgent');
          return;
       }

       if (data.peRatio === "UNKNOWN") {
          this.emitHold(traceId, symbol, "DATA_UNAVAILABLE: Fundamental data providers not configured.", currentPrice);
          notePipelineAgentSuccess('FundamentalAgent');
          return;
       }

       // Real bug found live (2026-09-07, same investigation as MacroAgent.ts's identical fix -
       // docs/audits/ARGUS_POST_AUDIT_REMEDIATION_PLAN.md R13): see that file's comment for the
       // full rationale. This gate previously only checked `process.env.GEMINI_API_KEY`, so an
       // Ollama-only deployment would never attempt a directional read here regardless of Ollama's
       // real availability.
       if (await AIRouter.getInstance().hasAnyRoutableProvider()) {
          const cacheDataType = `llm-analysis:FundamentalAgent:${AI_ANALYSIS_PROMPT_VERSION}:${hashObject(data)}`;
          const cached = await ExternalDataCache.getFresh<CachedAnalysis>('ai-cache', cacheDataType, symbol, AI_ANALYSIS_CACHE_MAX_AGE_MS);

          let analysis: CachedAnalysis;
          let aiCallId: string | undefined;
          let provider: string | undefined;
          let latencyMs: number | undefined;

          if (cached) {
             analysis = cached;
          } else {
             // Same enum-clarity fix as MacroAgent.ts's identical call site (2026-09-07) - applied
             // here too for consistency, though the MacroAgent-specific finding that motivated it
             // (627 stored real responses, 0 literal BUY/SELL) does NOT apply to FundamentalAgent,
             // which the same investigation confirmed already produces real graded directional
             // calls (36 WIN / 25 LOSS in agent_performance_stats history). This only reduces
             // ambiguous synonym drift; coerceEnum's safe-default-to-HOLD behavior is unchanged.
             const res = await AIRouter.getInstance().routeTask('FundamentalAgent', `Analyze these fundamentals for ${symbol}: P/E Ratio: ${data.peRatio}, EPS Growth: ${data.epsGrowth}%, Debt/Equity: ${data.debtToEquity}. Return strict JSON: { summary, recommendation, confidence, supportingEvidence, risks, reasoning }. recommendation must be exactly one of: "BUY", "SELL", "HOLD" - no other word or synonym.`, traceId);
             if (!res.content) {
                this.emitHold(traceId, symbol, 'DATA_UNAVAILABLE: Fundamental LLM returned an empty response.', currentPrice);
                notePipelineAgentFailure('FundamentalAgent', 'empty LLM content');
                return;
             }

             // Real bug found live (2026-09-02): a bare JSON.parse(res.content) threw on a valid,
             // substantive AI response that happened to be wrapped in a ```json fence - see
             // parseJsonFromLlmContent()'s own header for the full root-cause chain and evidence
             // (confirmed against MacroAgent's identical call site, same shared LLM/provider path).
             const raw = parseJsonFromLlmContent(res.content) as Record<string, unknown> | null;
             if (raw === null) {
                this.emitHold(traceId, symbol, 'DATA_UNAVAILABLE: Fundamental LLM response was not parseable JSON.', currentPrice);
                notePipelineAgentFailure('FundamentalAgent', 'unparseable LLM JSON');
                return;
             }
             analysis = {
                recommendation: coerceEnum(raw.recommendation, TRADE_SIDE_VALUES, 'HOLD'),
                confidence: normalizeConfidence01(raw.confidence),
                reasoning: coerceString(raw.reasoning, 'No reasoning provided.'),
             };
             aiCallId = res.aiCallId;
             provider = res.provider;
             latencyMs = res.latency;
             await ExternalDataCache.set('ai-cache', cacheDataType, symbol, analysis);
          }

          eventBus.emitTradeIdea({
             traceId,
             symbol,
             side: analysis.recommendation,
             confidence: analysis.confidence,
             currentPrice: currentPrice ?? undefined,
             reasoning: `[Fundamental AI] ${analysis.reasoning}`,
             agent: "FundamentalAgent",
             aiCallId,
             provider,
             latencyMs,
          });
          notePipelineAgentSuccess('FundamentalAgent');
          return;
       }

       this.emitHold(traceId, symbol, 'DATA_UNAVAILABLE: Fundamentals ingested but no LLM is configured for a directional idea.', currentPrice);
       notePipelineAgentSuccess('FundamentalAgent');
    } catch (e) {
       logErrorSafely('[FundamentalAgent] Failed:', e);
       notePipelineAgentFailure('FundamentalAgent', e);
       this.emitHold(generateTraceId(symbol), symbol, 'DATA_UNAVAILABLE: Fundamental analysis failed this tick; the next scheduled tick will still run.', currentPrice);
    }
  }
}

export const fundamentalAgent = new FundamentalAnalysisAgent();
