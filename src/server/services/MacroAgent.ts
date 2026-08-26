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
import { coerceEnum, normalizeConfidence01, coerceString, TRADE_SIDE_VALUES } from '../ai/AIOutputValidator';
import { logErrorSafely } from '../core/SecretRedaction';
import { generateTraceId } from '../core/traceId';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { networkEndpoints } from '../config/networkEndpoints';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { marketDataWorker } from './MarketDataWorker';
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

  private async fetchMacro() {
     if (!process.env.ALPHAVANTAGE_API_KEY) {
        return UNKNOWN_MACRO;
     }

     const cached = await ExternalDataCache.getFresh<typeof UNKNOWN_MACRO>('alphavantage', 'macro', null, MACRO_CACHE_MAX_AGE_MS);
     if (cached) return cached;

     if (await ExternalDataCache.isRateLimited('alphavantage', 'macro', null)) {
        const stale = await ExternalDataCache.getStale<typeof UNKNOWN_MACRO>('alphavantage', 'macro', null);
        if (stale) {
          console.warn('[MacroAgent] AlphaVantage backoff active — serving cached macro data.');
          return stale;
        }
        return RATE_LIMITED_MACRO;
     }

     try {
         const key = process.env.ALPHAVANTAGE_API_KEY;

         const avBase = networkEndpoints.marketData.alphaVantageBaseUrl;
         const fetchOne = async (fn: string): Promise<any> => {
           if (!(await AlphaVantageBudget.tryConsume(1, undefined, 'MacroAgent'))) return { __budgetExhausted: true };
           const r = await fetch(`${avBase}?function=${fn}&apikey=${key}`);
           if (r.status === 429) return { __http429: true };
           return r.json() as any;
         };
         const inflRes = await fetchOne('INFLATION');
         const fedRes = await fetchOne('FEDERAL_FUNDS_RATE');
         const unempRes = await fetchOne('UNEMPLOYMENT');

         if ([inflRes, fedRes, unempRes].some(r => r?.__http429 || r?.__budgetExhausted || looksLikeRateLimitResponse(r))) {
            const stale = await ExternalDataCache.getStale<typeof UNKNOWN_MACRO>('alphavantage', 'macro', null);
            if (stale) {
              console.warn('[MacroAgent] AlphaVantage rate limit — serving cached macro data.');
              return stale;
            }
            console.warn('[MacroAgent] AlphaVantage rate limit hit - backing off for 24h.');
            await ExternalDataCache.markRateLimited('alphavantage', 'macro', null);
            return RATE_LIMITED_MACRO;
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
    const symbol = universe[Math.floor(Date.now() / 75000) % universe.length];
    const traceId = generateTraceId(symbol);
    // Real fix (2026-08-24 readiness audit, Part 2) - see FundamentalAgent.ts's identical comment.
    eventBus.emit(EVENTS.PRICE_SNAPSHOT_REQUESTED, { symbol, requestedBy: 'MacroAgent', at: new Date().toISOString() });
    marketDataWorker.subscribe(symbol, { requestedBy: 'MacroAgent' });
    // See FundamentalAgent.ts's identical comment.
    const currentPrice = marketDataWorker.getLatestPrice(symbol);

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

       if (process.env.GEMINI_API_KEY) {
          const cacheDataType = `llm-analysis:MacroAgent:${AI_ANALYSIS_PROMPT_VERSION}:${hashObject(data)}`;
          const cached = await ExternalDataCache.getFresh<CachedAnalysis>('ai-cache', cacheDataType, symbol, AI_ANALYSIS_CACHE_MAX_AGE_MS);

          let analysis: CachedAnalysis;
          let aiCallId: string | undefined;
          let provider: string | undefined;
          let latencyMs: number | undefined;

          if (cached) {
             analysis = cached;
          } else {
             const res = await AIRouter.getInstance().routeTask('MacroAgent', `Analyze these macroeconomic indicators for their impact on ${symbol}: CPI ${data.inflation}%, Fed Funds Rate ${data.fedFundsRate}%, Unemployment ${data.unemployment}%. Return strict JSON: { summary, recommendation, confidence, supportingEvidence, risks, reasoning }`, traceId);
             if (!res.content) {
                this.emitHold(traceId, symbol, 'DATA_UNAVAILABLE: Macro LLM returned an empty response.', currentPrice);
                notePipelineAgentFailure('MacroAgent', 'empty LLM content');
                return;
             }

             const raw = JSON.parse(res.content);
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
             reasoning: `[Macro AI] ${analysis.reasoning}`,
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
