/**
 * ==========================================================
 * Module: FundamentalAgent.ts
 *
 * Purpose:
 * Evaluates real fundamental data if available.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
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
  private watchedSymbols = ['NVDA', 'AAPL', 'TSLA'];

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.analyzeFundamentals(), runtimeIntervals.fundamentalAgentMs);
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

    if (!(await AlphaVantageBudget.tryConsume(1))) {
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

  private async analyzeFundamentals() {
    if (!isLiveIdeaGenerationEnabled()) return;
    if (!isPipelineAgentEnabled('FundamentalAgent')) return;
    // We just pick a symbol round-robin or randomly from our list
    const symbol = this.watchedSymbols[Math.floor(Date.now() / 60000) % this.watchedSymbols.length];
    const traceId = generateTraceId(symbol);
    
    try {
       const data = await this.fetchFundamentals(symbol);

       if (data.peRatio === "RATE_LIMITED") {
          // Distinct, honest reason from "not configured" - the key is real and working, it's
          // just out of AlphaVantage's real daily quota. Mission Control's health view should be
          // able to tell these apart instead of collapsing both into the same generic message.
          eventBus.emitTradeIdea({
             traceId,
             symbol,
             side: "HOLD",
             confidence: 0,
             reasoning: "DATA_UNAVAILABLE: AlphaVantage daily rate limit exhausted - real data resumes after a 24h cooldown.",
             agent: "FundamentalAgent"
          });
          return;
       }

       if (data.peRatio === "UNKNOWN") {
          eventBus.emitTradeIdea({
             traceId,
             symbol,
             side: "HOLD",
             confidence: 0,
             reasoning: "DATA_UNAVAILABLE: Fundamental data providers not configured.",
             agent: "FundamentalAgent"
          });
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
             if (!res.content) return;

             const raw = JSON.parse(res.content);
             // Hardening pass, Phase 5: raw.recommendation/confidence previously flowed straight
             // into a real TRADE_IDEA_GENERATED event with no schema validation - an off-schema
             // recommendation (wrong case, an invented value) or a confidence answered on a
             // 0-100 scale (this prompt doesn't specify one) would corrupt ChiefTraderAgent's
             // 0-1-scale consensus math. Validated once here, immediately after parsing, BEFORE
             // caching, so a cache hit always replays an already-validated result.
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

          if (analysis.recommendation !== "HOLD") {
             eventBus.emitTradeIdea({
                traceId,
                symbol,
                side: analysis.recommendation,
                confidence: analysis.confidence,
                reasoning: `[Fundamental AI] ${analysis.reasoning}`,
                agent: "FundamentalAgent",
                aiCallId,
                provider,
                latencyMs,
             });
          }
       }
    } catch (e) {
       logErrorSafely('[FundamentalAgent] Failed:', e);
    }
  }
}

export const fundamentalAgent = new FundamentalAnalysisAgent();
