/**
 * ==========================================================
 * Module: MacroAgent.ts
 *
 * Purpose:
 * Evaluates real macro data if available.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { AIRouter } from '../ai/AIRouter';
import { ExternalDataCache, looksLikeRateLimitResponse, hashObject } from './ExternalDataCache';
import { coerceEnum, normalizeConfidence01, coerceString, TRADE_SIDE_VALUES } from '../ai/AIOutputValidator';
import { logErrorSafely } from '../core/SecretRedaction';
import crypto from 'crypto';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';

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
  private watchedSymbols = ['NVDA', 'AAPL', 'TSLA'];

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.analyzeMacro(), runtimeIntervals.macroAgentMs);
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
        return RATE_LIMITED_MACRO;
     }

     try {
         const key = process.env.ALPHAVANTAGE_API_KEY;

         const [inflRes, fedRes, unempRes] = await Promise.all([
             fetch(`https://www.alphavantage.co/query?function=INFLATION&apikey=${key}`).then(r => r.json() as any),
             fetch(`https://www.alphavantage.co/query?function=FEDERAL_FUNDS_RATE&apikey=${key}`).then(r => r.json() as any),
             fetch(`https://www.alphavantage.co/query?function=UNEMPLOYMENT&apikey=${key}`).then(r => r.json() as any)
         ]);

         if ([inflRes, fedRes, unempRes].some(looksLikeRateLimitResponse)) {
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

  private async analyzeMacro() {
    if (!isLiveIdeaGenerationEnabled()) return;
    const symbol = this.watchedSymbols[Math.floor(Date.now() / 75000) % this.watchedSymbols.length];
    const traceId = crypto.randomUUID();
    
    try {
       const data = await this.fetchMacro();
       if (data.inflation === "RATE_LIMITED") {
          eventBus.emitTradeIdea({
             traceId,
             symbol,
             side: "HOLD",
             confidence: 0,
             reasoning: "DATA_UNAVAILABLE: AlphaVantage daily rate limit exhausted - real data resumes after a 24h cooldown.",
             agent: "MacroAgent"
          });
          return;
       }
       if (data.inflation === "UNKNOWN") {
          eventBus.emitTradeIdea({
             traceId,
             symbol,
             side: "HOLD",
             confidence: 0,
             reasoning: "DATA_UNAVAILABLE: Macro data providers not configured.",
             agent: "MacroAgent"
          });
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
             if (!res.content) return;

             const raw = JSON.parse(res.content);
             // Hardening pass, Phase 5: see FundamentalAgent.ts's identical comment - validated
             // once here, immediately after parsing, BEFORE caching, so a cache hit always
             // replays an already-validated result.
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
                reasoning: `[Macro AI] ${analysis.reasoning}`,
                agent: "MacroAgent",
                aiCallId,
                provider,
                latencyMs,
             });
          }
       }
    } catch (e) {
       logErrorSafely('[MacroAgent] Failed:', e);
    }
  }
}

export const macroAgent = new MacroEconomyAgent();
