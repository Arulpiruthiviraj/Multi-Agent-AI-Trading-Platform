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
import { coerceEnum, normalizeConfidence01, coerceString, TRADE_SIDE_VALUES } from '../ai/AIOutputValidator';
import { logErrorSafely } from '../core/SecretRedaction';
import { generateTraceId } from '../core/traceId';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { networkEndpoints } from '../config/networkEndpoints';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { marketDataWorker } from './MarketDataWorker';
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

  private async fetchFundamentals(symbol: string) {
    if (!process.env.ALPHAVANTAGE_API_KEY) {
      return UNKNOWN_FUNDAMENTALS;
    }

    const cached = await ExternalDataCache.getFresh<typeof UNKNOWN_FUNDAMENTALS>('alphavantage', 'fundamentals', symbol, FUNDAMENTALS_CACHE_MAX_AGE_MS);
    if (cached) return cached;

    if (await ExternalDataCache.isRateLimited('alphavantage', 'fundamentals', symbol)) {
      const stale = await ExternalDataCache.getStale<typeof UNKNOWN_FUNDAMENTALS>('alphavantage', 'fundamentals', symbol);
      if (stale) {
        console.warn(`[FundamentalAgent] AlphaVantage backoff active for ${symbol} — serving cached fundamentals.`);
        return stale;
      }
      return { peRatio: 'RATE_LIMITED', epsGrowth: 'RATE_LIMITED', debtToEquity: 'RATE_LIMITED' };
    }

    if (!(await AlphaVantageBudget.tryConsume(1, undefined, 'FundamentalAgent'))) {
      const stale = await ExternalDataCache.getStale<typeof UNKNOWN_FUNDAMENTALS>('alphavantage', 'fundamentals', symbol);
      if (stale) {
        console.warn(`[FundamentalAgent] AlphaVantage daily budget exhausted — serving cached fundamentals for ${symbol}.`);
        return stale;
      }
      return { peRatio: 'RATE_LIMITED', epsGrowth: 'RATE_LIMITED', debtToEquity: 'RATE_LIMITED' };
    }

    try {
      const response = await fetch(`${networkEndpoints.marketData.alphaVantageBaseUrl}?function=OVERVIEW&symbol=${symbol}&apikey=${process.env.ALPHAVANTAGE_API_KEY}`);
      if (response.status === 429) {
        const stale = await ExternalDataCache.getStale<typeof UNKNOWN_FUNDAMENTALS>('alphavantage', 'fundamentals', symbol);
        if (stale) {
          console.warn(`[FundamentalAgent] AlphaVantage HTTP 429 for ${symbol} — serving cached fundamentals.`);
          return stale;
        }
        console.warn(`[FundamentalAgent] AlphaVantage rate limit hit for ${symbol} - backing off for 24h.`);
        await ExternalDataCache.markRateLimited('alphavantage', 'fundamentals', symbol);
        return { peRatio: 'RATE_LIMITED', epsGrowth: 'RATE_LIMITED', debtToEquity: 'RATE_LIMITED' };
      }
      const data = await response.json() as any;

      if (looksLikeRateLimitResponse(data)) {
        const stale = await ExternalDataCache.getStale<typeof UNKNOWN_FUNDAMENTALS>('alphavantage', 'fundamentals', symbol);
        if (stale) {
          console.warn(`[FundamentalAgent] AlphaVantage rate-limit body for ${symbol} — serving cached fundamentals.`);
          return stale;
        }
        console.warn(`[FundamentalAgent] AlphaVantage rate limit hit for ${symbol} - backing off for 24h.`);
        await ExternalDataCache.markRateLimited('alphavantage', 'fundamentals', symbol);
        return { peRatio: 'RATE_LIMITED', epsGrowth: 'RATE_LIMITED', debtToEquity: 'RATE_LIMITED' };
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

    return UNKNOWN_FUNDAMENTALS;
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
    const traceId = generateTraceId(symbol);
    // Real fix (2026-08-24 readiness audit, Part 2): this round-robin previously never requested
    // coverage for its own evaluation target - it only ever passively read getLatestPrice() and
    // hoped the symbol happened to already be streamed for some unrelated reason (opportunity-
    // discovery priority). With only a fraction of the ~122-symbol universe actually streamed at
    // once, most picks had no live tick at all - the deterministic, traceable cause of most
    // MISSING_PRICE rejections. subscribe() is idempotent/cap-aware (MarketDataWorker.ts) and emits
    // SYMBOL_NOT_SUBSCRIBED/MARKET_DATA_CAPACITY_FULL - this does not fabricate a price for THIS
    // tick, it only improves the odds this symbol has a real one the next time it comes up.
    eventBus.emit(EVENTS.PRICE_SNAPSHOT_REQUESTED, { symbol, requestedBy: 'FundamentalAgent', at: new Date().toISOString() });
    marketDataWorker.subscribe(symbol, { requestedBy: 'FundamentalAgent' });
    // Same authoritative live-price source gateTradeIdea's own lookupLivePrice fallback already
    // reads (MarketDataWorker's WS tick cache, registered via setTradeIdeaLivePriceLookup) -
    // attached explicitly here rather than relying solely on that global fallback. Never invented,
    // never stale: null when this symbol has no live tick yet, exactly like the fallback would see.
    const currentPrice = marketDataWorker.getLatestPrice(symbol);

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

       if (process.env.GEMINI_API_KEY) {
          const cacheDataType = `llm-analysis:FundamentalAgent:${AI_ANALYSIS_PROMPT_VERSION}:${hashObject(data)}`;
          const cached = await ExternalDataCache.getFresh<CachedAnalysis>('ai-cache', cacheDataType, symbol, AI_ANALYSIS_CACHE_MAX_AGE_MS);

          let analysis: CachedAnalysis;
          let aiCallId: string | undefined;
          let provider: string | undefined;
          let latencyMs: number | undefined;

          if (cached) {
             analysis = cached;
          } else {
             const res = await AIRouter.getInstance().routeTask('FundamentalAgent', `Analyze these fundamentals for ${symbol}: P/E Ratio: ${data.peRatio}, EPS Growth: ${data.epsGrowth}%, Debt/Equity: ${data.debtToEquity}. Return strict JSON: { summary, recommendation, confidence, supportingEvidence, risks, reasoning }`, traceId);
             if (!res.content) {
                this.emitHold(traceId, symbol, 'DATA_UNAVAILABLE: Fundamental LLM returned an empty response.', currentPrice);
                notePipelineAgentFailure('FundamentalAgent', 'empty LLM content');
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
