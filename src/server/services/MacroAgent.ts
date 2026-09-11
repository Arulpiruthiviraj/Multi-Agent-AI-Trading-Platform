/**
 * ==========================================================
 * Module: MacroAgent.ts
 *
 * Purpose:
 * Evaluates real macro data if available.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { AIRouter } from '../ai/AIRouter';
import { ExternalDataCache, looksLikeRateLimitResponse, hashObject } from './ExternalDataCache';
import { AlphaVantageBudget } from './AlphaVantageBudget';
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
import { getFinceptMacroSnapshot, formatFinceptMacroSnapshotForPrompt } from './FinceptCacheAdapter';
import {
  notePipelineAgentFailure,
  notePipelineAgentGated,
  notePipelineAgentSuccess,
  notePipelineAgentTick,
} from '../core/pipelineAgentHealth';

const UNKNOWN_MACRO = { inflation: 'UNKNOWN', fedFundsRate: 'UNKNOWN', unemployment: 'UNKNOWN' };
const RATE_LIMITED_MACRO = { inflation: 'RATE_LIMITED', fedFundsRate: 'RATE_LIMITED', unemployment: 'RATE_LIMITED' };
// CPI/Fed Funds/unemployment are monthly-cadence US macro releases - refetching every 75s was
// never going to see new information, only burn AlphaVantage's 25-req/day quota. This data is
// also symbol-independent (unlike fundamentals) - cached once globally (symbol=null), not
// per-"currently analyzed symbol", which is what the previous version wastefully did despite the
// data itself never actually depending on which symbol happened to be selected that cycle.
const MACRO_CACHE_MAX_AGE_MS = runtimeIntervals.macroCacheMaxAgeMs;

// Hardening pass, Phase 7: see FundamentalAgent.ts's identical comment - the 24h cache above only
// ever gated the raw AlphaVantage fetch, not the downstream LLM call. Cached per real analyzed
// symbol still (macro data is global, but the AI's own analysis text is written "for their impact
// on {symbol}", so a real cache hit must match the same symbol the prior analysis was written
// for) + a hash of the exact macro data used + a prompt-version tag.
const AI_ANALYSIS_PROMPT_VERSION = 'v1';
const AI_ANALYSIS_CACHE_MAX_AGE_MS = MACRO_CACHE_MAX_AGE_MS;

interface CachedAnalysis { recommendation: string; confidence: number; reasoning: string; }

export class MacroEconomyAgent {
  private intervalId: NodeJS.Timeout | null = null;
  private inFlight = false;
  /** See FundamentalAgent.ts's identical field - set before any gate check so a stale value with
   * the interval supposedly running reveals a silently wedged tick rather than a gated-off one. */
  public lastTickAt: number | null = null;

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => { void this.tickSafely(); }, runtimeIntervals.macroAgentMs);
    void this.tickSafely();
  }

  private async tickSafely(): Promise<void> {
    if (this.inFlight) {
      this.lastTickAt = Date.now();
      notePipelineAgentTick('MacroAgent');
      return;
    }
    this.inFlight = true;
    try {
      await this.analyzeMacro();
    } catch (e) {
      notePipelineAgentFailure('MacroAgent', e);
      logErrorSafely('[MacroAgent] Tick failed (interval continues):', e);
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
   * Free fallback macro provider (2026-09-10, real AlphaVantage-daily-cap-exhaustion finding:
   * 160 real DATA_UNAVAILABLE HOLDs from MacroAgent in one session). FRED (Federal Reserve
   * Economic Data) is the free, no-payment, authoritative U.S. government source these same
   * indicators ultimately come from - not a lesser substitute for AlphaVantage's macro endpoint,
   * arguably a more direct one. Fed Funds Rate (FEDFUNDS) and Unemployment (UNRATE) are already
   * published as rates - single most-recent-observation fetch. CPI (CPIAUCSL) is published as an
   * index level, not a rate, so inflation % is computed as a real year-over-year change (13
   * monthly observations, (latest - 12mo_ago) / 12mo_ago * 100) - the standard definition of "the
   * CPI inflation rate," not a shortcut. Any missing/short series fails closed to 'UNKNOWN' for
   * that one field rather than fabricating a number. Only ever attempted after AlphaVantage has
   * already given up - never the primary source.
   */
  private async fetchFredSeries(seriesId: string, limit: number): Promise<Array<{ date: string; value: number }>> {
    const key = process.env.FRED_API_KEY;
    if (!key) return [];
    const url = `${networkEndpoints.marketData.fredBaseUrl}?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`;
    const response = await fetch(url);
    if (!response.ok) return [];
    const body = await response.json() as any;
    const obs = Array.isArray(body?.observations) ? body.observations : [];
    return obs
      .map((o: any) => ({ date: o.date, value: Number(o.value) }))
      .filter((o: { date: string; value: number }) => Number.isFinite(o.value));
  }

  private async tryFredFallback(): Promise<typeof UNKNOWN_MACRO | null> {
    if (!process.env.FRED_API_KEY) return null;
    try {
      const [cpiObs, fedFundsObs, unrateObs] = await Promise.all([
        this.fetchFredSeries('CPIAUCSL', 13),
        this.fetchFredSeries('FEDFUNDS', 1),
        this.fetchFredSeries('UNRATE', 1),
      ]);

      let inflation: string = 'UNKNOWN';
      if (cpiObs.length >= 13) {
        const latest = cpiObs[0].value;
        const yearAgo = cpiObs[12].value;
        if (yearAgo !== 0) {
          inflation = (((latest - yearAgo) / yearAgo) * 100).toFixed(2);
        }
      }
      const fedFundsRate = fedFundsObs[0] ? String(fedFundsObs[0].value) : 'UNKNOWN';
      const unemployment = unrateObs[0] ? String(unrateObs[0].value) : 'UNKNOWN';

      if (inflation === 'UNKNOWN' && fedFundsRate === 'UNKNOWN' && unemployment === 'UNKNOWN') {
        return null;
      }
      const result = { inflation, fedFundsRate, unemployment };
      // Cached under its own provider namespace, never conflated with AlphaVantage's cache row -
      // a later AlphaVantage recovery must not be shadowed by a stale FRED fallback result.
      await ExternalDataCache.set('fred', 'macro', null, result);
      console.warn('[MacroAgent] AlphaVantage unavailable — served real macro data from FRED fallback.');
      return result;
    } catch (e) {
      logErrorSafely('[MacroAgent] FRED fallback fetch failed:', e);
      return null;
    }
  }

  private async fetchMacroGiveUp(warnPrefix: string): Promise<typeof UNKNOWN_MACRO> {
    const stale = await ExternalDataCache.getStale<typeof UNKNOWN_MACRO>('alphavantage', 'macro', null);
    if (stale) {
      console.warn(`[MacroAgent] ${warnPrefix} — serving cached macro data.`);
      return stale;
    }
    const fred = await this.tryFredFallback();
    if (fred) return fred;
    return RATE_LIMITED_MACRO;
  }

  private async fetchMacro() {
     if (!process.env.ALPHAVANTAGE_API_KEY) {
        const fred = await this.tryFredFallback();
        return fred ?? UNKNOWN_MACRO;
     }

     const cached = await ExternalDataCache.getFresh<typeof UNKNOWN_MACRO>('alphavantage', 'macro', null, MACRO_CACHE_MAX_AGE_MS);
     if (cached) return cached;

     if (await ExternalDataCache.isRateLimited('alphavantage', 'macro', null)) {
        return this.fetchMacroGiveUp('AlphaVantage backoff active');
     }

     try {
         const key = process.env.ALPHAVANTAGE_API_KEY;

         const avBase = networkEndpoints.marketData.alphaVantageBaseUrl;
         const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
         const fetchOne = async (fn: string): Promise<any> => {
           if (!(await AlphaVantageBudget.tryConsume(1, undefined, 'MacroAgent'))) return { __budgetExhausted: true };
           const r = await fetch(`${avBase}?function=${fn}&apikey=${key}`);
           if (r.status === 429) return { __http429: true };
           return r.json() as any;
         };
         // Real DB evidence (Phase 9 zero-trade root-cause audit, 2026-08-27): this cache row had
         // never once been successfully populated - fetched_at stuck at 0 with a rolling 24h
         // rate_limited_until. Firing 3 AlphaVantage calls back-to-back was plausible enough on its
         // own to trip AlphaVantage's real per-minute limiter even with daily budget headroom - a
         // small pacing delay between sub-calls reduces that without changing the real daily quota.
         const inflRes = await fetchOne('INFLATION');
         await sleep(tradingSafety.alphaVantageMacroSubcallDelayMs);
         const fedRes = await fetchOne('FEDERAL_FUNDS_RATE');
         await sleep(tradingSafety.alphaVantageMacroSubcallDelayMs);
         const unempRes = await fetchOne('UNEMPLOYMENT');

         const subResults = [inflRes, fedRes, unempRes];
         const genuineExternalRateLimit = subResults.some(r => r?.__http429 || looksLikeRateLimitResponse(r));
         // Real fix: __budgetExhausted only means OUR shared internal daily counter ran out this
         // cycle (e.g. FundamentalAgent's round-robin claimed the remaining slots first) - it is not
         // AlphaVantage itself signaling a rate limit. Treating it identically to a genuine 429 used
         // to arm a full 24h backoff off a purely internal bookkeeping event, permanently starving
         // MacroAgent even on a day where AlphaVantage itself never once refused a request. Only a
         // real external signal earns the 24h cooldown; internal exhaustion just retries next cycle.
         const internalBudgetExhausted = !genuineExternalRateLimit && subResults.some(r => r?.__budgetExhausted);

         if (genuineExternalRateLimit) {
            console.warn('[MacroAgent] AlphaVantage rate limit hit - backing off for 24h.');
            await ExternalDataCache.markRateLimited('alphavantage', 'macro', null);
            return this.fetchMacroGiveUp('AlphaVantage rate limit');
         }

         if (internalBudgetExhausted) {
            console.warn('[MacroAgent] Shared AlphaVantage daily budget exhausted this cycle — retrying next cycle (no 24h backoff; this was not AlphaVantage itself refusing the request).');
            return this.fetchMacroGiveUp('Shared AlphaVantage daily budget exhausted this cycle');
         }

         let inflation = "UNKNOWN";
         let fedFundsRate = "UNKNOWN";
         let unemployment = "UNKNOWN";

         if (inflRes?.data?.[0]?.value) inflation = inflRes.data[0].value;
         if (fedRes?.data?.[0]?.value) fedFundsRate = fedRes.data[0].value;
         if (unempRes?.data?.[0]?.value) unemployment = unempRes.data[0].value;

         const result = { inflation, fedFundsRate, unemployment };
         if (inflation !== 'UNKNOWN' || fedFundsRate !== 'UNKNOWN' || unemployment !== 'UNKNOWN') {
            await ExternalDataCache.set('alphavantage', 'macro', null, result);
         }
         return result;
     } catch (e) {
         // AlphaVantage's API only supports key-in-query-string auth - see SecretRedaction.ts.
         logErrorSafely('[MacroAgent] AlphaVantage fetch failed:', e);
     }

     return UNKNOWN_MACRO;
  }

  // See FundamentalAgent.ts's identical comment - attaching currentPrice explicitly rather than
  // relying solely on gateTradeIdea's separate lookupLivePrice fallback registration.
  private emitHold(traceId: string, symbol: string, reasoning: string, currentPrice?: number | null): void {
    eventBus.emitTradeIdea({
      traceId,
      symbol,
      side: 'HOLD',
      confidence: 0,
      reasoning,
      agent: 'MacroAgent',
      currentPrice: currentPrice ?? undefined,
    });
  }

  async analyzeMacro() {
    this.lastTickAt = Date.now();
    notePipelineAgentTick('MacroAgent');
    if (!isLiveIdeaGenerationEnabled()) {
      notePipelineAgentGated('MacroAgent');
      return;
    }
    if (!isPipelineAgentEnabled('MacroAgent')) {
      notePipelineAgentGated('MacroAgent');
      return;
    }
    const universe = resolveIdeaUniverse();
    if (universe.length === 0) {
      notePipelineAgentGated('MacroAgent');
      return;
    }
    // Phase 7F (2026-08-27) - see FundamentalAgent.ts's identical fix/comment.
    const freshSymbols = universe.filter((s) => {
      const age = marketDataWorker.getLatestPriceAgeMs(s);
      return age !== null && age <= tradingSafety.stalePriceThresholdMs;
    });
    // Phase 9 (same-candidate convergence): see FundamentalAgent.ts's identical comment.
    const recentCandidates = getRecentCandidates(tradingSafety.recentCandidatePriorityMaxAgeMs).filter((s) => freshSymbols.includes(s));
    const priorityPool = recentCandidates.length > 0 ? recentCandidates : freshSymbols;
    const symbol = selectPriorityRoundRobinSymbol(universe, priorityPool, runtimeIntervals.macroAgentMs, Date.now());
    await this.evaluateSymbol(symbol);
  }

  /** Phase 9 (same-candidate convergence) - see FundamentalAgent.ts's identical evaluateSymbol()
   *  for the full rationale. Lets ConfluenceCoordinator request an on-demand evaluation for a
   *  specific real candidate symbol instead of only ever waiting for this agent's own round-robin.
   *  Re-checks the safety gate itself, independent of the caller. */
  async evaluateSymbol(symbol: string): Promise<void> {
    if (!isLiveIdeaGenerationEnabled() || !isPipelineAgentEnabled('MacroAgent')) return;

    const traceId = generateTraceId(symbol);
    // Original fix (2026-08-24 readiness audit, Part 2) + completed fix (2026-09-06 remediation,
    // docs/audits/ARGUS_CURRENT_STATE_AND_PAPER_READINESS_AUDIT.md §26/§30 finding R3) - see
    // FundamentalAgent.ts's identical evaluateSymbol() for the full rationale: MacroAgent was
    // confirmed live (real DB query) as one of the two dominant MISSING_PRICE sources after
    // NewsEngine's 2026-09-03 fix collapsed that agent's share. Same fix applied here.
    eventBus.emit(EVENTS.PRICE_SNAPSHOT_REQUESTED, { symbol, requestedBy: 'MacroAgent', at: new Date().toISOString() });
    marketDataWorker.subscribe(symbol, { requestedBy: 'MacroAgent' });
    const freshData = await waitForFreshMarketData(symbol, {
      requestClass: 'ROUTINE_RECOVERY',
      reason: 'MacroAgent_awaiting_fresh_price',
      traceId,
    });
    if (freshData.ok === false) {
      const reasoning = freshData.reason === 'RESCUE_DENIED'
        ? `DATA_UNAVAILABLE: market-data rescue denied for ${symbol} (${freshData.deniedReason}). No fabricated price emitted.`
        : freshData.reason === 'ERROR'
        ? `DATA_UNAVAILABLE: fresh-data wait errored for ${symbol} (${freshData.detail}). No fabricated price emitted.`
        : `DATA_UNAVAILABLE: no fresh tick arrived for ${symbol} within ${tradingSafety.newsPriceWaitTimeoutMs}ms. No fabricated price emitted.`;
      this.emitHold(traceId, symbol, reasoning, null);
      notePipelineAgentSuccess('MacroAgent');
      return;
    }
    const currentPrice = freshData.price;

    try {
       const data = await this.fetchMacro();
       if (data.inflation === "RATE_LIMITED") {
          this.emitHold(traceId, symbol, "DATA_UNAVAILABLE: AlphaVantage daily rate limit exhausted - real data resumes after a 24h cooldown.", currentPrice);
          notePipelineAgentSuccess('MacroAgent');
          return;
       }
       if (data.inflation === "UNKNOWN") {
          this.emitHold(traceId, symbol, "DATA_UNAVAILABLE: Macro data providers not configured.", currentPrice);
          notePipelineAgentSuccess('MacroAgent');
          return;
       }

       // Real bug found live (2026-09-07, MacroAgent 100%-HOLD investigation,
       // docs/audits/ARGUS_POST_AUDIT_REMEDIATION_PLAN.md R13): this gate previously checked only
       // `process.env.GEMINI_API_KEY`, hardcoded to one specific provider - a deployment configured
       // with only Ollama (no Gemini key at all, e.g. after this session's own AI Cost Governor
       // push toward preferring free local models) would never even attempt a directional read
       // here, always falling through to the "no LLM configured" HOLD below, regardless of Ollama's
       // real availability. AIRouter.hasAnyRoutableProvider() reuses routeTask's own routable-
       // provider filter (cooldown/disabled-aware), so this now correctly reflects whatever the
       // real routing table can actually reach - Ollama-only, Gemini-only, or both.
       if (await AIRouter.getInstance().hasAnyRoutableProvider()) {
          const cacheDataType = `llm-analysis:MacroAgent:${AI_ANALYSIS_PROMPT_VERSION}:${hashObject(data)}`;
          const cached = await ExternalDataCache.getFresh<CachedAnalysis>('ai-cache', cacheDataType, symbol, AI_ANALYSIS_CACHE_MAX_AGE_MS);

          let analysis: CachedAnalysis;
          let aiCallId: string | undefined;
          let provider: string | undefined;
          let latencyMs: number | undefined;

          if (cached) {
             analysis = cached;
          } else {
             // Real, evidence-backed fix (2026-09-07, MacroAgent 100%-HOLD investigation): a direct
             // read of 627 real, complete stored responses (data/argus.db's ai_calls table,
             // agent='MacroAgent', raw_response length > 500) found the model never once returned a
             // literal "BUY"/"SELL" for this prompt - 599 said "Hold" outright, and the other 28
             // used a non-standard synonym (NEUTRAL/MAINTAIN/MONITOR/ADOPT/EXERCISE/PROCEED) that
             // coerceEnum() already, correctly, safely defaults to HOLD rather than guessing (see
             // AIOutputValidator.ts's own documented contract - this was never a coercion bug).
             // This is not a fabricated-signal fix - it does not push the model toward more BUY/SELL
             // calls, nor touch confidence/RiskEngine/consensus. It only removes an unforced source
             // of noise (a model reaching for its own synonym instead of the exact expected word) by
             // stating the literal allowed values, so a genuine HOLD reads as HOLD and a genuine
             // directional read - if the model ever has one for macro data - isn't lost to
             // a wording mismatch instead of a real safe-default.
             const res = await AIRouter.getInstance().routeTask('MacroAgent', `Analyze these macroeconomic indicators for their impact on ${symbol}: CPI ${data.inflation}%, Fed Funds Rate ${data.fedFundsRate}%, Unemployment ${data.unemployment}%. Return strict JSON: { summary, recommendation, confidence, supportingEvidence, risks, reasoning }. recommendation must be exactly one of: "BUY", "SELL", "HOLD" - no other word or synonym.`, traceId);
             if (!res.content) {
                this.emitHold(traceId, symbol, 'DATA_UNAVAILABLE: Macro LLM returned an empty response.', currentPrice);
                notePipelineAgentFailure('MacroAgent', 'empty LLM content');
                return;
             }

             // Real bug found live (2026-09-02): a bare JSON.parse(res.content) threw on a valid,
             // substantive Mistral response that happened to be wrapped in a ```json fence - see
             // parseJsonFromLlmContent()'s own header for the full root-cause chain and evidence.
             const raw = parseJsonFromLlmContent(res.content) as Record<string, unknown> | null;
             if (raw === null) {
                this.emitHold(traceId, symbol, 'DATA_UNAVAILABLE: Macro LLM response was not parseable JSON.', currentPrice);
                notePipelineAgentFailure('MacroAgent', 'unparseable LLM JSON');
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

          // Fincept advisory context (2026-09-07, off by default via
          // ENABLE_FINCEPT_CACHE_ADVISORY): appended to the REASONING TEXT only,
          // deliberately outside the cached `analysis` object above and computed
          // fresh on every emit regardless of cache hit/miss - it must never
          // affect the LLM prompt/cache key (see FinceptCacheAdapter.ts's header:
          // folding a live snapshot into the hashed prompt would let a changed
          // VIX go unnoticed by a cache hit) and never affect confidence/side.
          // Fails silently to '' when Fincept isn't running or has no fresh
          // data - the common case - and the line is simply omitted.
          const finceptSnapshot = getFinceptMacroSnapshot();
          const finceptNote = finceptSnapshot ? ` ${formatFinceptMacroSnapshotForPrompt(finceptSnapshot)}` : '';

          eventBus.emitTradeIdea({
             traceId,
             symbol,
             side: analysis.recommendation,
             confidence: analysis.confidence,
             currentPrice: currentPrice ?? undefined,
             reasoning: `[Macro AI] ${analysis.reasoning}${finceptNote}`,
             agent: "MacroAgent",
             aiCallId,
             provider,
             latencyMs,
          });
          notePipelineAgentSuccess('MacroAgent');
          return;
       }

       this.emitHold(traceId, symbol, 'DATA_UNAVAILABLE: Macro data ingested but no LLM is configured for a directional idea.', currentPrice);
       notePipelineAgentSuccess('MacroAgent');
    } catch (e) {
       logErrorSafely('[MacroAgent] Failed:', e);
       notePipelineAgentFailure('MacroAgent', e);
       this.emitHold(generateTraceId(symbol), symbol, 'DATA_UNAVAILABLE: Macro analysis failed this tick; the next scheduled tick will still run.', currentPrice);
    }
  }
}

export const macroAgent = new MacroEconomyAgent();
