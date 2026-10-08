import { NewsProviderManager } from './NewsProviderManager';
import { NewsNormalizer } from './NewsNormalizer';
import { NewsDeduplicator } from './NewsDeduplicator';
import { NewsCredibilityEngine } from './NewsCredibilityEngine';
import { NewsClassifier } from './NewsClassifier';
import { NewsSymbolExtractor } from './NewsSymbolExtractor';
import { NewsImpactEngine } from './NewsImpactEngine';
import { NewsClusterEngine } from './NewsClusterEngine';
import { NewsScoringEngine, AIAnalysisResult, buildLocalFirstNewsAnalysis } from './NewsScoringEngine';
import { kickOffJevShadowScoring } from './JevNewsTriage';
import { isJevEscalationEnabled } from './JevEscalation';
import { NormalizedArticle } from './NewsNormalizer';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingSafety } from '../config/tradingSafety';
import { decideEscalation } from '../ai/EscalationPolicy';
import { db } from '../db';
import * as schema from '../db/schema';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { generateTraceId } from '../core/traceId';
import { randomUUID } from 'node:crypto';
import { recordPitLive } from '../engines/backtest/PitLedgerRecorder';
import { deskIntelligence, newsAgentEmitsTradeIdeas, newsAgentPipelineEnabled, newsAgentObservesPredictions } from '../config/deskIntelligence';
import { recordNewsCatalyst, rehydrateStagedCatalystsFromDb } from '../services/NewsCatalystStore';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { notePipelineAgentFailure, notePipelineAgentSuccess, notePipelineAgentTick } from '../core/pipelineAgentHealth';
import { marketDataWorker } from '../services/MarketDataWorker';
import { waitForFreshMarketData } from '../core/waitForFreshMarketData';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { recordNewsPrediction } from './NewsPredictionLedger';
import { resolveNewsEnginePollMs, isUsEquityRegularSession } from './newsSessionCadence';
import { marketOpenNewsConfluence } from './MarketOpenNewsConfluence';

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
  /** Prevent overlapping runPipeline ticks when LLM/RSS latency exceeds newsEngineMs. */
  private pipelineInFlight = false;
  private currentPollMs: number | null = null;

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
    // Phase F Step 2: newsAgentMode === 'DISABLED' is a new, additive capability - no prior
    // config value could stop ingestion/clustering/news_veto feed entirely. Default mode
    // (CATALYST_ONLY) never triggers this, so this is not a behavior change for any existing
    // deployment's config.
    if (!newsAgentPipelineEnabled()) {
      console.log('[NewsEngine] newsAgentMode=DISABLED - not starting News Intelligence Pipeline.');
      return;
    }
    console.log('[NewsEngine] Starting News Intelligence Pipeline (24/7; adaptive RTH/off-hours cadence)...');
    this.scheduleAdaptiveInterval();
    // 2026-09-27 Phase 2 carryover fix: NewsCatalystStore's STAGED_FOR_OPEN queue is now durable
    // (drizzle/0075_staged_news_catalysts.sql). Must repopulate the in-memory queue from that
    // table BEFORE MarketOpenNewsConfluence.start() runs, or a restart between an overnight
    // staging and the next open would present an empty queue exactly as it did before this fix.
    // Fire-and-forget from this synchronous method's own caller's perspective (start() itself
    // stays sync, matching every existing call site - ArgusCoreBoot.ts/SystemBootstrap.ts do not
    // await it today), but internally sequenced: confluence.start() only runs after rehydration
    // resolves, never in parallel with it.
    void rehydrateStagedCatalystsFromDb().finally(() => {
      marketOpenNewsConfluence.start();
    });
    this.runPipeline();
  }

  /** RTH uses newsEngineMs; overnight/weekend uses newsEngineOffHoursMs. Re-arms on cadence change. */
  private scheduleAdaptiveInterval(): void {
    const nextMs = resolveNewsEnginePollMs();
    if (this.intervalId && this.currentPollMs === nextMs) return;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.currentPollMs = nextMs;
    this.intervalId = setInterval(() => {
      this.scheduleAdaptiveInterval();
      void this.runPipeline();
    }, nextMs);
    console.log(
      `[NewsEngine] Poll cadence ${nextMs}ms (${isUsEquityRegularSession() ? 'RTH' : 'off-hours'})`,
    );
  }

  /** Synthetic Market Session Simulator test seam (2026-10-06) - same pattern as
   *  QuantSignalAgent.triggerNow()/PortfolioMonitor.triggerNow(): exposes the existing real
   *  runPipeline() cycle for an explicit caller running on an injected/accelerated clock, where
   *  this engine's own real setInterval never fires because .start() was skipped
   *  (ARGUS_NEWS_ENGINE_ENABLED=false in that harness). Not a parallel decision path - the
   *  identical private cycle the timer already calls. */
  public async triggerNow(): Promise<void> {
    await this.runPipeline();
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.currentPollMs = null;
    marketOpenNewsConfluence.stop();
    console.log('[NewsEngine] Stopped.');
  }

  private async runPipeline() {
    if (this.pipelineInFlight) return;
    this.pipelineInFlight = true;
    notePipelineAgentTick('NewsAgent');
    let fetchedCount = 0;
    let analyzedCount = 0;
    try {
    const rawArticles = await this.providerManager.fetchAllLatest();
    fetchedCount = rawArticles.length;
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
        let finalSymbols = this.symbolExtractor.extract(normalized)
          .map(s => looksLikeListedTicker(s))
          .filter((s): s is string => !!s);
        const impact = await this.impactEngine.assess(normalized, category);
        
        const clusterOutcome = await this.clusterEngine.createOrUpdateCluster(
          normalized,
          category,
          impact,
          credibility,
          finalSymbols
        );
        if (!clusterOutcome) {
          // Either a DB error, or (onConflictDoNothing) this article was already persisted in a
          // prior process lifetime - either way, don't burn an AI call re-analyzing it.
          continue;
        }
        const { isNewCluster, priorArticleCount } = clusterOutcome;
        analyzedCount += 1;

        const traceId = generateTraceId(finalSymbols[0] ?? 'NEWS');

        eventBus.publish(EVENTS.NEWS_ANALYSIS_STARTED, { traceId, headline: normalized.title, source: normalized.source });

        const escalationDecision = decideEscalation({
          localSource: 'finbert',
          localSignalAvailable: impact.sentimentSource === 'finbert',
          localConfidence: Math.abs(impact.sentiment),
          decisiveThreshold: DECISIVE_SENTIMENT_THRESHOLD,
        });

        // Jev Phase 2 escalation (2026-10-06): when ARGUS_JEV_ESCALATION_ENABLED=true,
        // Jev scores first and the LLM runs only on low confidence / high stakes /
        // Jev-unavailable. When the flag is off, this block is skipped entirely and the
        // existing FinBERT→LLM path below runs byte-for-byte unchanged.
        // The accepted Jev path never calls the LLM; the escalated path is identical
        // to the no-flag behavior. Either way, no trading decision is influenced.
        let jevAcceptedAnalysis: AIAnalysisResult | null = null;
        if (isJevEscalationEnabled() && finalSymbols.length > 0) {
          jevAcceptedAnalysis = await this.tryJevFirstAnalysis(normalized, {
            symbol: finalSymbols[0],
            traceId,
            category,
            credibility,
            isNewCluster,
            priorArticleCount,
            impactScore01: impact.impactScore,
            timeHorizon: impact.timeHorizon,
          });
        }

        let aiAnalysis: AIAnalysisResult | null = jevAcceptedAnalysis;
        // Pure LLM result, captured separately for the Jev shadow agreement ledger
        // (Phase 1): aiAnalysis may later be overwritten by the local-first fallback,
        // but agreement measurement needs the LLM's own scores or an explicit null.
        let llmAnalysisForShadow: AIAnalysisResult | null = null;
        // When Jev's score was accepted above, the LLM path is skipped entirely —
        // aiAnalysis already holds the Jev-built result.
        if (!jevAcceptedAnalysis && escalationDecision.escalate && llmCallsThisCycle < tradingSafety.newsLlmMaxCallsPerCycle) {
          llmCallsThisCycle += 1;
          try {
            aiAnalysis = await this.scoringEngine.analyzeWithAI(normalized, traceId, {
              category,
              impactScore01: impact.impactScore,
              timeHorizon: impact.timeHorizon,
              isNewCluster,
              priorArticleCount,
              credibility,
            });
            llmAnalysisForShadow = aiAnalysis;
          } catch (llmErr) {
            console.warn(`[NewsEngine] LLM analysis threw; using ${impact.sentimentSource} so the NewsAgent cycle is not blocked.`, llmErr);
            aiAnalysis = null;
          }
          if (!aiAnalysis && finalSymbols.length > 0) {
            console.warn(`[NewsEngine] LLM analysis failed (404/timeout/parse); using ${impact.sentimentSource} so the NewsAgent cycle is not blocked.`);
            aiAnalysis = buildLocalFirstNewsAnalysis(normalized, {
              symbol: finalSymbols[0],
              category,
              sentiment: impact.sentiment,
              impactScore01: impact.impactScore,
              timeHorizon: impact.timeHorizon,
              isNewCluster,
              priorArticleCount,
              credibility,
              reasoning: `[Local-First] Remote LLM failed; using ${impact.sentimentSource} sentiment ${impact.sentiment.toFixed(2)}.`,
            });
          }
        } else if (!jevAcceptedAnalysis && finalSymbols.length > 0 && (!escalationDecision.escalate || llmCallsThisCycle >= tradingSafety.newsLlmMaxCallsPerCycle)) {
          if (escalationDecision.escalate) {
            console.warn(`[NewsEngine] Skipping LLM escalation — cycle cap ${tradingSafety.newsLlmMaxCallsPerCycle} reached (DEF-14).`);
          }
          aiAnalysis = buildLocalFirstNewsAnalysis(normalized, {
            symbol: finalSymbols[0],
            category,
            sentiment: impact.sentiment,
            impactScore01: impact.impactScore,
            timeHorizon: impact.timeHorizon,
            isNewCluster,
            priorArticleCount,
            credibility,
            reasoning: escalationDecision.escalate
              ? `[Local-First] LLM cycle cap reached; using FinBERT sentiment ${impact.sentiment.toFixed(2)}.`
              : `[Local-First] FinBERT sentiment ${impact.sentiment > 0 ? 'positive' : 'negative'} (${impact.sentiment.toFixed(2)}) was decisive enough to skip the LLM call.`,
          });
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

        // Jev shadow scoring (Phase 1, 2026-10-06): fire-and-forget, flag-gated (default OFF).
        // Scores this article with Jev in parallel and records the agreement observation.
        // Never blocks, never throws, never influences any decision — trading is untouched.
        if (finalSymbols.length > 0) {
          kickOffJevShadowScoring({
            article: normalized,
            symbol: finalSymbols[0],
            traceId,
            llmAnalysis: llmAnalysisForShadow,
            deterministic: {
              category,
              credibility,
              isNewCluster,
              priorArticleCount,
              impactScore01: impact.impactScore,
              timeHorizon: impact.timeHorizon,
            },
          });
        }

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
                expectedHorizon: aiAnalysis.expectedHorizon,
                referencePrice: marketDataWorker.getLatestPrice(symbol),
                clusterId: clusterOutcome.clusterId,
              };
              const recorded = recordNewsCatalyst(catalyst);
              eventBus.emit(EVENTS.NEWS_CATALYST, recorded);
              if (recorded.status === 'STAGED_FOR_OPEN') {
                eventBus.publish(EVENTS.NEWS_CATALYST_STAGED, recorded);
              }

              // Phase F5: persist a prediction for later evaluation (Phase F6, not yet built)
              // only in ACTIVE_OBSERVE and above - dormant at the CATALYST_ONLY default. Fire-
              // and-forget like the rest of this loop's side effects; recordNewsPrediction
              // catches its own errors and never throws.
              if (newsAgentObservesPredictions()) {
                void recordNewsPrediction({
                  clusterId: clusterOutcome.clusterId,
                  traceId,
                  symbol,
                  direction: aiAnalysis.tradingBias,
                  confidence: aiAnalysis.confidence,
                  expectedHorizon: aiAnalysis.expectedHorizon,
                  referencePrice: marketDataWorker.getLatestPrice(symbol),
                  reasoning: aiAnalysis.reasoning,
                  materiality: aiAnalysis.materiality,
                  catalystType: aiAnalysis.catalystType,
                  riskLevel: aiAnalysis.riskLevel,
                  riskVeto: aiAnalysis.riskVeto,
                  sourceCount: clusterOutcome.sourceCount,
                  modelSource: aiAnalysis._provider ?? 'local-first',
                  stagingStatus: recorded.status === 'STAGED_FOR_OPEN' ? 'STAGED_FOR_OPEN' : 'ACTIVE',
                  expiresAt: recorded.expiresAtMs != null ? new Date(recorded.expiresAtMs).toISOString() : null,
                });
              }
              // Default desk policy: news is a catalyst, not an independent BUY/SELL vote.
              // Mission Control NewsAgent switch gates ideas only; clustering above still runs
              // so RiskEngine news_veto is not starved.
              if (newsAgentEmitsTradeIdeas() && isLiveIdeaGenerationEnabled() && isPipelineAgentEnabled('NewsAgent')) {
                const ticker = looksLikeListedTicker(symbol);
                if (!ticker) return;
                eventBus.emit(EVENTS.PRICE_SNAPSHOT_REQUESTED, { symbol: ticker, requestedBy: 'NewsAgent', at: new Date().toISOString() });
                // Real fix (2026-09-03, Sept-2 forensic-audit remediation - see
                // docs/audits/ARGUS_ARCHITECTURE_AND_MARKET_DAY_FORENSIC_AUDIT_2026-09-02.md
                // section 13.1). The prior version requested a subscription and then read
                // marketDataWorker.getLatestPrice() on the very next line, with zero wait for that
                // subscription to actually produce a tick - for exactly the case this exists to
                // handle (a catalyst about a symbol outside the currently-streamed set), that
                // reliably returned null and every idea was rejected MISSING_PRICE before
                // ChiefTrader ever saw it (confirmed live: 147/147 Sept-2 MISSING_PRICE rejections,
                // ~100% NewsAgent). Fixed by awaiting a bounded, allocator-aware wait for a real
                // fresh tick (waitForFreshMarketData.ts, goes through the same reviewed
                // requestTemporaryDataRescue() path every other rescue caller uses, class
                // NEWS_CATALYST) instead of a raw subscribe()+immediate-read. Fire-and-forget so a
                // slow/denied wait for one symbol never blocks this loop's other symbols/articles.
                // FundamentalAgent.ts had the identical latent structural bug at its own matching
                // comment - fixed 2026-09-06 (docs/audits/ARGUS_CURRENT_STATE_AND_PAPER_READINESS_AUDIT.md
                // §26/§30 finding R3, confirmed live: FundamentalAgent had become the dominant
                // MISSING_PRICE source once this fix shipped here). MacroAgent.ts received the same
                // fix. Corrected 2026-09-14 (forensic defect audit,
                // docs/ARGUS_FULL_DEFECT_AUDIT.md) - this comment previously claimed the fix was
                // still outstanding, which was stale by that point and could have misled a future
                // pass into re-doing already-completed work.
                void (async () => {
                  try {
                    const outcome = await waitForFreshMarketData(ticker, {
                      requestClass: 'NEWS_CATALYST',
                      reason: 'NewsAgent_awaiting_fresh_price',
                      traceId,
                    });
                    if (outcome.ok === false) {
                      const eventType = outcome.reason === 'RESCUE_DENIED' ? 'NEWS_IDEA_DISCARDED_RESCUE_DENIED'
                        : outcome.reason === 'ERROR' ? 'NEWS_IDEA_DISCARDED_ERROR'
                        : 'NEWS_IDEA_DISCARDED_NO_FRESH_DATA';
                      const reasoning = outcome.reason === 'RESCUE_DENIED'
                        ? `NewsAgent idea for ${ticker} discarded - market-data rescue denied (${outcome.deniedReason}). No fabricated price emitted.`
                        : outcome.reason === 'ERROR'
                        ? `NewsAgent idea for ${ticker} discarded - fresh-data wait errored (${outcome.detail}). No fabricated price emitted.`
                        : `NewsAgent idea for ${ticker} discarded - no fresh tick arrived within ${tradingSafety.newsPriceWaitTimeoutMs}ms of requesting coverage. No fabricated price emitted.`;
                      observeSafe(() => {
                        structuredLogger.info('news_idea_discarded_no_fresh_data', {
                          category: 'DISCOVERY', eventType, symbol: ticker, traceId, reasoning,
                        });
                      });
                      return;
                    }
                    // Same authoritative live-price source `referencePrice` above already reads
                    // (MarketDataWorker) - now a real, freshness-verified tick, never stale/fabricated.
                    eventBus.emitTradeIdea({
                       traceId,
                       symbol: ticker,
                       side: newsSide,
                       confidence: newsConfidence,
                       currentPrice: outcome.price,
                       reasoning: `[News Intelligence] ${aiAnalysis.reasoning}`,
                       agent: "NewsAgent",
                       origin: 'NEWS_EVENT',
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
                  } catch (e) {
                    console.error(`[NewsEngine] fresh-data wait failed for ${ticker}`, e);
                  }
                })();
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
          clusterId: clusterOutcome.clusterId,
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
    // Heartbeat even when every article was a duplicate — Digital Twin otherwise stays IDLE
    // between rare new headlines while MarketData pulses continuously on ticks.
    // Telemetry honesty: successful cluster/analysis cycles mark lastSuccessfulTickAt even when
    // newsAgentMode is CATALYST_ONLY (ideas intentionally disabled). Ideas-off ≠ pipeline-dead.
    eventBus.publish(EVENTS.NEWS_PIPELINE_TICK, {
      telemetryPulse: true,
      fetched: fetchedCount,
      analyzed: analyzedCount,
      newsAgentMode: deskIntelligence.newsAgentMode,
      ideasEmitting: newsAgentEmitsTradeIdeas(),
      liveIdeaGenerationEnabled: isLiveIdeaGenerationEnabled(),
      newsAgentPipelineEnabled: isPipelineAgentEnabled('NewsAgent'),
      at: new Date().toISOString(),
    });
    // A cycle that ran to completion (even zero new/qualifying articles) is a real success -
    // was never recorded before, so lastSuccessfulTickAt stayed permanently null even on
    // healthy cycles (see ARGUS_PHASE2_FORENSIC_AUDIT.md #3).
    notePipelineAgentSuccess('NewsAgent');
    } catch (e) {
      notePipelineAgentFailure('NewsAgent', e);
      console.error('[NewsEngine] Pipeline tick failed (interval continues):', e);
    } finally {
      this.pipelineInFlight = false;
    }
  }

  /**
   * Jev Phase 2 (2026-10-06): score one article with Jev and decide whether the LLM
   * is needed. Returns an AIAnalysisResult built from Jev's score when Jev is
   * confident (LLM skipped), or null when the existing LLM path should run.
   * Never throws — any failure means "fall through to the existing path".
   * Only called when ARGUS_JEV_ESCALATION_ENABLED=true.
   */
  private async tryJevFirstAnalysis(
    article: NormalizedArticle,
    opts: {
      symbol: string;
      traceId: string;
      category: string;
      credibility: number;
      isNewCluster: boolean;
      priorArticleCount: number;
      impactScore01: number;
      timeHorizon: string;
    },
  ): Promise<AIAnalysisResult | null> {
    try {
      const { buildJevNewsState, scoreArticleWithJev } = await import('./JevNewsTriage');
      const { JevProvider } = await import('../ai/providers/JevProvider');
      const { decideJevEscalation, buildJevAnalysisResult } = await import('./JevEscalation');

      const apiKey = (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || '').trim();
      if (!apiKey) return null;

      const state = buildJevNewsState(article, opts.symbol, {
        category: opts.category,
        credibility: opts.credibility,
        isNewCluster: opts.isNewCluster,
        priorArticleCount: opts.priorArticleCount,
        impactScore01: opts.impactScore01,
        timeHorizon: opts.timeHorizon,
      });
      if (!state) return null; // imperfect data — existing path handles it

      const provider = new JevProvider();
      await provider.initialize(apiKey);
      // Tighter than the shadow default: this call blocks the article's analysis.
      const score = await scoreArticleWithJev(provider, state, { timeoutMs: 8000 });

      const decision = decideJevEscalation({ jevScore: score, credibility: opts.credibility });
      console.log(`[NewsEngine][Jev] ${opts.symbol}: ${decision.reason}`);
      if (decision.escalateToLlm) return null;

      return buildJevAnalysisResult(article, score, {
        symbol: opts.symbol,
        category: opts.category,
        impactScore01: opts.impactScore01,
        timeHorizon: opts.timeHorizon,
        isNewCluster: opts.isNewCluster,
        priorArticleCount: opts.priorArticleCount,
        credibility: opts.credibility,
      });
    } catch (e) {
      console.warn('[NewsEngine][Jev] triage failed, falling through to existing path:', (e as Error)?.message || e);
      return null;
    }
  }
}

export const newsEngine = NewsEngine.getInstance();
