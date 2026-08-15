/**
 * ==========================================================
 * Module: ReflectionEngine.ts
 *
 * Purpose:
 * Analyzes actual trades and agent performance based on
 * real market data rather than simulated outcomes.
 * ==========================================================
 */
import { db } from '../db';
import { agentPredictions, agentPerformanceStats, agentConfidenceCalibration, trades, learnedRules, predictionOutcomes } from '../db/schema';
import { eq } from 'drizzle-orm';
import { eventBus } from '../core/EventBus';
import { AIRouter } from '../ai/AIRouter';
import { bucketFor, calibratedConfidenceForBucket } from './ConfidenceCalibration';
import crypto from 'crypto';

export class ReflectionEngine {
  private intervalId: NodeJS.Timeout | null = null;
  
  constructor() {
    eventBus.on('TRADE_IDEA_GENERATED', (idea) => this.logPrediction(idea));
  }

  async logPrediction(idea: any) {
    try {
      await db.insert(agentPredictions).values({
        id: crypto.randomUUID(),
        agentName: idea.agent,
        symbol: idea.symbol,
        prediction: idea.side,
        confidence: idea.confidence,
        reasoning: idea.reasoning,
        timestamp: idea.timestamp || new Date().toISOString(),
        // Phase 1 - the agent's own traceId (joinable to consensus_evidence.source_trace_id),
        // and AI call telemetry when this idea came from a real LLM call (undefined/null for
        // TechnicalAgent and the FinBERT local-first path - correctly absent, not fabricated).
        traceId: idea.traceId,
        aiCallId: idea.aiCallId,
        provider: idea.provider,
        latencyMs: idea.latencyMs,
      });
    } catch (e) {
      console.error("[ReflectionEngine] Error logging prediction:", e);
    }
  }

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.evaluateAgents(), 60000); // every 60s
    console.log("[ReflectionEngine] Continuous Self-Improvement Loop started.");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async evaluateAgents() {
    console.log("[ReflectionEngine] Measuring AI performance based on real outcomes...");
    try {
      const allTrades = await db.select().from(trades).all();
      const now = Date.now();
      
      let successfulTradesCount = 0;
      let failedTradesCount = 0;
      let recentLosses: any[] = [];
      
      for (const t of allTrades) {
         if (t.status !== 'FILLED' || t.side !== 'SELL') continue;
         if (t.profitLoss === null || t.profitLoss === undefined) continue;

         const tradeTime = new Date(t.timestamp).getTime();
         const isProfitable = t.profitLoss > 0;

         if (isProfitable) {
             successfulTradesCount++;
         } else {
             failedTradesCount++;
             if (now - tradeTime < 3600000) {
                 recentLosses.push({ symbol: t.symbol, side: t.side, entry: t.price, realizedPnl: t.profitLoss, reasoning: t.reasoning });
             }
         }
      }

      // Phase 4 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md): previously this compared a prediction
      // to whatever FILLED trade happened to be nearby (within 5 minutes) - a coarse proxy, not
      // the real price at a defined horizon after the prediction. PredictionOutcomeEvaluator now
      // does that properly using real point-in-time OHLCV bars; this just reads its results.
      // total/correct only count predictions that have actually been evaluated (a real
      // prediction_outcomes row exists) - not every prediction ever made, which previously
      // silently diluted win rate with predictions that were never even checked.
      const statsMap: Record<string, any> = {};
      // Phase 1A - real Beta-Binomial confidence calibration per (agent, stated-confidence
      // bucket): keyed by `${bucket.low}-${bucket.high}`, distinct from statsMap's flat
      // agent-wide win rate above. See ConfidenceCalibration.ts's header for why this exists -
      // NewsAgent's real overall win rate can look unremarkable while it's still systematically
      // overconfident specifically in its high-confidence bucket, which a flat weight can't see.
      const calibrationMap: Record<string, Record<string, { wins: number; losses: number }>> = {};
      const predictions = await db.select().from(agentPredictions).all();
      const predictionById = new Map(predictions.map(p => [p.id, p]));
      const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));

      for (const o of outcomes) {
        const p = predictionById.get(o.predictionId);
        if (!p) continue;
        if (!statsMap[p.agentName]) {
          statsMap[p.agentName] = { total: 0, correct: 0, sumReturn: 0 };
        }
        if (o.outcome === 'N_A') continue; // HOLD-style predictions made no directional call to score
        statsMap[p.agentName].total += 1;
        const absReturn = Math.abs(o.actualReturn ?? 0);
        if (o.outcome === 'WIN') {
          statsMap[p.agentName].correct += 1;
          statsMap[p.agentName].sumReturn += absReturn;
        } else {
          statsMap[p.agentName].sumReturn -= absReturn;
        }

        const bucket = bucketFor(p.confidence);
        const bucketKey = `${bucket.low}-${bucket.high}`;
        if (!calibrationMap[p.agentName]) calibrationMap[p.agentName] = {};
        if (!calibrationMap[p.agentName][bucketKey]) calibrationMap[p.agentName][bucketKey] = { wins: 0, losses: 0 };
        if (o.outcome === 'WIN') calibrationMap[p.agentName][bucketKey].wins += 1;
        else calibrationMap[p.agentName][bucketKey].losses += 1;
      }

      for (const [agentName, buckets] of Object.entries(calibrationMap)) {
        for (const [bucketKey, { wins, losses }] of Object.entries(buckets)) {
          const [low, high] = bucketKey.split('-').map(Number);
          const calibratedConfidence = calibratedConfidenceForBucket({ low, high }, wins, losses);
          await db.insert(agentConfidenceCalibration).values({
            agentName, bucketLow: low, bucketHigh: high, wins, losses, calibratedConfidence,
            lastEvaluated: new Date().toISOString(),
          }).onConflictDoUpdate({
            target: [agentConfidenceCalibration.agentName, agentConfidenceCalibration.bucketLow],
            set: { wins, losses, calibratedConfidence, lastEvaluated: new Date().toISOString() },
          });
        }
      }

      let totalWeight = 0;
      for (const [agentName, data] of Object.entries(statsMap)) {
        if (data.total === 0) continue;
        const winRate = data.correct / (data.total || 1);
        const avgReturn = data.sumReturn / (data.total || 1);
        const profitFactor = winRate > 0 ? (winRate * 1.5) / ((1 - winRate) || 0.1) : 0;
        
        const newWeight = Math.max(0.1, 1.0 + ((winRate - 0.5) * 2)); 
        totalWeight += newWeight;
        
        const sharpeRatio = avgReturn === 0 ? 0 : (avgReturn * Math.sqrt(252)) / 0.1; // Simulated Sharpe using stddev 0.1
        
        await db.insert(agentPerformanceStats).values({
          agentName,
          totalPredictions: data.total,
          correctPredictions: data.correct,
          winRate,
          averageReturn: avgReturn,
          profitFactor,
          sharpeRatio: sharpeRatio,
          currentWeight: newWeight,
          lastEvaluated: new Date().toISOString()
        }).onConflictDoUpdate({
          target: agentPerformanceStats.agentName,
          set: {
            totalPredictions: data.total,
            correctPredictions: data.correct,
            winRate,
            averageReturn: avgReturn,
            profitFactor,
            sharpeRatio: sharpeRatio,
            currentWeight: newWeight,
            lastEvaluated: new Date().toISOString()
          }
        });
      }

      if (recentLosses.length > 0) {
          await this.generateReflectionRule(recentLosses);
      }
    } catch (e) {
      console.error("[ReflectionEngine] Error evaluating agents:", e);
    }
  }

  async generateReflectionRule(recentLosses: any[]) {
      try {
          const prompt = `Review these recent trading losses and generate a 1-sentence strict reflection rule to prevent similar losses in the future. Losses: ${JSON.stringify(recentLosses.slice(0,3))}`;
          
          const traceId = crypto.randomUUID();
          const res = await AIRouter.getInstance().routeTask('ReflectionEngine', prompt, traceId);
          
          const rule = res.content || "Avoid trading during unexpected volatility spikes.";
          
          eventBus.emitLearningEvent({
              traceId,
              agent: 'ReflectionEngine',
              cause: 'Post-trade drawdown analysis',
              rule: rule,
              confidence: 0.95
          });
          
          await db.insert(learnedRules).values({
             id: crypto.randomUUID(),
             rule: rule,
             agent: 'ReflectionEngine',
             cause: 'Post-trade drawdown analysis',
             confidence: 0.95,
             timestamp: new Date().toISOString()
          });
      } catch (e) {
          console.error("[ReflectionEngine] Failed to generate rule via AIRouter:", e);
      }
  }
}

export const reflectionEngine = new ReflectionEngine();
