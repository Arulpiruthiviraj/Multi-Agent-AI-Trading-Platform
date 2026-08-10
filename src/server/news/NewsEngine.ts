import { NewsProviderManager } from './NewsProviderManager';
import { NewsNormalizer } from './NewsNormalizer';
import { NewsDeduplicator } from './NewsDeduplicator';
import { NewsCredibilityEngine } from './NewsCredibilityEngine';
import { NewsClassifier } from './NewsClassifier';
import { NewsSymbolExtractor } from './NewsSymbolExtractor';
import { NewsImpactEngine } from './NewsImpactEngine';
import { NewsClusterEngine } from './NewsClusterEngine';
import { NewsScoringEngine } from './NewsScoringEngine';
import { eventBus } from '../core/EventBus';

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
    this.intervalId = setInterval(() => this.runPipeline(), 10000);
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
        let finalSymbols = this.symbolExtractor.extract(normalized);
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

        const traceId = Math.random().toString(36).substring(7);
        const aiAnalysis = await this.scoringEngine.analyzeWithAI(normalized, traceId);
        
        if (aiAnalysis) {
          if (aiAnalysis.symbol) {
            finalSymbols = Array.from(new Set([...finalSymbols, aiAnalysis.symbol]));
          }
          
          if (aiAnalysis.tradingBias !== 'NEUTRAL') {
            finalSymbols.forEach(symbol => {
              eventBus.emitTradeIdea({
                 traceId,
                 symbol,
                 side: aiAnalysis.tradingBias === 'BULLISH' ? 'BUY' : 'SELL',
                 confidence: (aiAnalysis.confidence / 100) * credibility, // Weighted confidence
                 reasoning: `[News Intelligence] ${aiAnalysis.reasoning}`,
                 agent: "NewsAgent",
                 newsDetails: {
                     used: true,
                     sentiment: (aiAnalysis as any).sentimentScore || 0,
                     confidence: aiAnalysis.confidence / 100,
                     sources: normalized.source,
                     reasoning: aiAnalysis.reasoning
                 }
              });
            });
          }
        }
        
        eventBus.publish('NEWS_ANALYZED', {
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
