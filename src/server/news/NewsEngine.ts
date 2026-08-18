import { NewsProviderManager } from './NewsProviderManager';
import { NewsNormalizer } from './NewsNormalizer';
import { NewsDeduplicator } from './NewsDeduplicator';
import { NewsCredibilityEngine } from './NewsCredibilityEngine';
import { NewsClassifier } from './NewsClassifier';
import { NewsSymbolExtractor } from './NewsSymbolExtractor';
import { NewsImpactEngine } from './NewsImpactEngine';
import { NewsClusterEngine } from './NewsClusterEngine';
import { NewsScoringEngine, AIAnalysisResult } from './NewsScoringEngine';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingSafety } from '../config/tradingSafety';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { decideEscalation } from '../ai/EscalationPolicy';
import { db } from '../db';
import * as schema from '../db/schema';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { generateTraceId } from '../core/traceId';
import { randomUUID } from 'node:crypto';
import { recordPitLive } from '../engines/backtest/PitLedgerRecorder';
import { deskIntelligence } from '../config/deskIntelligence';
import { recordNewsCatalyst } from '../services/NewsCatalystStore';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';

// A FinBERT sentiment magnitude at/above this is treated as decisive enough to skip the LLM call
// entirely - see EscalationPolicy.ts. Below it, the signal is too weak/ambiguous to trust alone.
const DECISIVE_SENTIMENT_THRESHOLD = tradingSafety.newsDecisiveSentimentThreshold;

export class NewsEngine {
  private static instance: NewsEngine;
  public providerManager: NewsProviderManager;
  private normalizer: NewsNormalizer;
  private deduplicator: NewsDeduplicator;
  private credibilityEngine: NewsCredibilityEngine;
  private classifier: NewsClassifier;
  private symbolExtractor: NewsSymbolExtractor;
  private impactEngine: NewsImpactEngine;
  private clusterEngine: NewsClusterEngine;
  private scoringEngine: NewsScoringEngine;
  
  private intervalId: NodeJS.Timeout | null = null;

  private constructor() {
    this.providerManager = new NewsProviderManager();
    this.normalizer = new NewsNormalizer();
    this.deduplicator = new NewsDeduplicator();
    this.credibilityEngine = new NewsCredibilityEngine();
    this.classifier = new NewsClassifier();
    this.symbolExtractor = new NewsSymbolExtractor();
    this.impactEngine = new NewsImpactEngine();
    this.clusterEngine = new NewsClusterEngine();
    this.scoringEngine = new NewsScoringEngine();
  }

  public static getInstance(): NewsEngine {
    if (!NewsEngine.instance) {
      NewsEngine.instance = new NewsEngine();
    }
    return NewsEngine.instance;
  }

  public start() {
    if (this.intervalId) return;
    console.log('[NewsEngine] Starting News Intelligence Pipeline...');
    this.intervalId = setInterval(() => this.runPipeline(), runtimeIntervals.newsEngineMs);
    this.runPipeline();
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[NewsEngine] Stopped.');
  }

  private async runPipeline() {
    const rawArticles = await this.providerManager.fetchAllLatest();
    let llmCallsThisCycle = 0;
    
    for (const raw of rawArticles) {
      try {
        const normalized = this.normalizer.normalize(raw);
        if (this.deduplicator.isDuplicate(normalized)) {
          continue;
        }

        const credibility = this.credibilityEngine.assess(normalized, 0.8);
        if (credibility < 0.3) {
          continue;
        }

        const category = this.classifier.classify(normalized);
        let finalSymbols = this.symbolExtractor.extract(normalized).filter(s => looksLikeListedTicker(s));
        const impact = await this.impactEngine.assess(normalized, category);
        
        const clusterId = await this.clusterEngine.createOrUpdateCluster(
          normalized,
          category,
          impact,
          credibility,
          finalSymbols
        );
        if (!clusterId) {
          // Either a DB error, or (onConflictDoNothing) this article was already persisted in a
          // prior process lifetime - either way, don't burn an AI call re-analyzing it.
          continue;
        }

        const traceId = generateTraceId(finalSymbols[0] ?? 'NEWS');

        eventBus.publish(EVENTS.NEWS_ANALYSIS_STARTED, { traceId, headline: normalized.title, source: normalized.source });

        const escalationDecision = decideEscalation({
          localSource: 'finbert',
          localSignalAvailable: impact.sentimentSource === 'finbert',
          localConfidence: Math.abs(impact.sentiment),
          decisiveThreshold: DECISIVE_SENTIMENT_THRESHOLD,
        });

        let aiAnalysis: AIAnalysisResult | null = null;
        if (escalationDecision.escalate && llmCallsThisCycle < tradingSafety.newsLlmMaxCallsPerCycle) {
          llmCallsThisCycle += 1;
          aiAnalysis = await this.scoringEngine.analyzeWithAI(normalized, traceId);
        } else if (finalSymbols.length > 0 && (!escalationDecision.escalate || llmCallsThisCycle >= tradingSafety.newsLlmMaxCallsPerCycle)) {
          if (escalationDecision.escalate) {
            console.warn(`[NewsEngine] Skipping LLM escalation — cycle cap ${tradingSafety.newsLlmMaxCallsPerCycle} reached (DEF-14).`);
          }
          const localConfidencePct = Math.round(Math.min(85, 50 + Math.abs(impact.sentiment) * 40));
          aiAnalysis = {
            symbol: finalSymbols[0],
            headline: normalized.title,
            source: normalized.source,
            timestamp: normalized.publishedAt,
            category,
            sentimentScore: impact.sentiment,
            marketImpactScore: impact.impactScore * 100,
            confidence: localConfidencePct,
            affectedSectors: [],
            tradingBias: impact.sentiment > 0 ? 'BULLISH' : 'BEARISH',
            reasoning: escalationDecision.escalate
              ? `[Local-First] LLM cycle cap reached; using FinBERT sentiment ${impact.sentiment.toFixed(2)}.`
              : `[Local-First] FinBERT sentiment ${impact.sentiment > 0 ? 'positive' : 'negative'} (${impact.sentiment.toFixed(2)}) was decisive enough to skip the LLM call.`,
            riskFlags: [],
          };
        }

        try {
          await db.insert(schema.escalationDecisions).values({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            traceId,
            agent: 'NewsAgent',
            task: 'news_sentiment_analysis',
            localSource: 'finbert',
            localSignalAvailable: impact.sentimentSource === 'finbert',
            localConfidence: Math.abs(impact.sentiment),
            decisiveThreshold: DECISIVE_SENTIMENT_THRESHOLD,
            escalated: escalationDecision.escalate,
            reason: escalationDecision.reason,
            escalatedProvider: escalationDecision.escalate ? 'NewsAgent AIRouter route' : null,
          });
        } catch (e) {
          console.error('[NewsEngine] Failed to log escalation decision', e);
        }

        // Real-time broadcast of the same decision just persisted above - lets the UI show local-
        // first escalation as it happens, not just after querying escalation_decisions later.
        eventBus.publish(EVENTS.ESCALATION_DECISION, {
          traceId,
          agent: 'NewsAgent',
          localSource: 'finbert',
          localConfidence: Math.abs(impact.sentiment),
          escalated: escalationDecision.escalate,
          reason: escalationDecision.reason,
        });

        const articlePublishedMs = Date.parse(normalized.publishedAt);

        if (aiAnalysis) {
          if (aiAnalysis.symbol) {
            const ticker = looksLikeListedTicker(aiAnalysis.symbol);
            if (ticker) finalSymbols = Array.from(new Set([...finalSymbols, ticker]));
          }
          
          if (aiAnalysis.tradingBias !== 'NEUTRAL') {
            finalSymbols.forEach(symbol => {
              if (!looksLikeListedTicker(symbol)) return;
              const newsSide = aiAnalysis.tradingBias === 'BULLISH' ? 'BUY' as const : 'SELL' as const;
              const newsConfidence = (aiAnalysis.confidence / 100) * credibility;
              const contribution = Number((newsConfidence * (aiAnalysis.tradingBias === 'BEARISH' ? -1 : 1)).toFixed(3));
              const catalystStrength: 'LOW' | 'MODERATE' | 'HIGH' =
                newsConfidence >= 0.75 ? 'HIGH' : newsConfidence >= 0.45 ? 'MODERATE' : 'LOW';
              recordPitLive({
                kind: 'NEWS_AGENT',
                symbol,
                publishedAtMs: Number.isFinite(articlePublishedMs) ? articlePublishedMs : undefined,
                agent: 'NewsAgent',
                side: newsSide,
                confidence: newsConfidence,
                finbertScore: impact.sentimentSource === 'finbert' ? impact.sentiment : undefined,
                payloadJson: JSON.stringify({ traceId, reasoning: aiAnalysis.reasoning, catalyst: true }),
                source: 'NewsEngine',
              });
              const catalyst = {
                traceId,
                symbol,
                headline: normalized.title,
                source: normalized.source,
                publishedAtMs: Number.isFinite(articlePublishedMs) ? articlePublishedMs : null,
                sentiment: impact.sentimentSource === 'finbert' ? impact.sentiment : null,
                credibility,
                catalystStrength,
                tradingBias: aiAnalysis.tradingBias as 'BULLISH' | 'BEARISH' | 'NEUTRAL',
                contribution,
                reasoning: aiAnalysis.reasoning,
                recordedAt: new Date().toISOString(),
              };
              recordNewsCatalyst(catalyst);
              eventBus.emit(EVENTS.NEWS_CATALYST, catalyst);
              // Default desk policy: news is a catalyst, not an independent BUY/SELL vote.
              // Mission Control NewsAgent switch gates ideas only; clustering above still runs
              // so RiskEngine news_veto is not starved.
              if (deskIntelligence.newsEmitsTradeIdeas && isLiveIdeaGenerationEnabled() && isPipelineAgentEnabled('NewsAgent')) {
                eventBus.emitTradeIdea({
                   traceId,
                   symbol,
                   side: newsSide,
                   confidence: newsConfidence,
                   reasoning: `[News Intelligence] ${aiAnalysis.reasoning}`,
                   agent: "NewsAgent",
                   newsDetails: {
                       used: true,
                       sentiment: (aiAnalysis as any).sentimentScore || 0,
                       confidence: aiAnalysis.confidence / 100,
                       sources: normalized.source,
                       reasoning: aiAnalysis.reasoning
                   },
                   aiCallId: aiAnalysis._aiCallId,
                   provider: aiAnalysis._provider,
                   latencyMs: aiAnalysis._latencyMs,
                });
              }
            });
          }
        }
        
        for (const symbol of finalSymbols) {
          if (!looksLikeListedTicker(symbol)) continue;
          recordPitLive({
            kind: 'NEWS',
            symbol,
            publishedAtMs: Number.isFinite(articlePublishedMs) ? articlePublishedMs : undefined,
            finbertScore: impact.sentimentSource === 'finbert' ? impact.sentiment : undefined,
            impactScore: impact.impactScore <= 1 ? impact.impactScore * 100 : impact.impactScore,
            payloadJson: JSON.stringify({
              headline: normalized.title,
              source: normalized.source,
              sentimentSource: impact.sentimentSource,
            }),
            source: 'NewsEngine',
          });
        }

        eventBus.publish(EVENTS.NEWS_ANALYZED, {
          id: normalized.id,
          clusterId,
          symbols: finalSymbols,
          impact: impact,
          credibility,
          category,
          aiAnalysis
        });

      } catch (err) {
        console.error('[NewsEngine] Pipeline error for article:', raw.title, err);
      }
    }
  }
}

export const newsEngine = NewsEngine.getInstance();
