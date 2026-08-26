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
import { agentPredictions, agentPerformanceStats, agentConfidenceCalibration, trades, learnedRules, predictionOutcomes, kronosPredictions } from '../db/schema';
import { eq } from 'drizzle-orm';
import { eventBus } from '../core/EventBus';
import { AIRouter } from '../ai/AIRouter';
import { bucketFor, calibratedConfidenceForBucket } from './ConfidenceCalibration';
import crypto from 'crypto';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { tradingSafety } from '../config/tradingSafety';
import { defaultAgentWeights } from '../config/agentWeights';
import { agentWeightUpdate, boundedStep } from '../research/agentWeightPolicy';
import { rawVsEffectiveDirectional, classifyEvidenceStatus, type ClusterableRow } from '../research/effectiveSampleSize';
import { independenceClusterGapMs, isExcludedFromWeightLearning, secondaryGroupKey } from '../research/predictionIndependencePolicy';
import { isTelemetryPulsePayload, TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';
import { NON_LIVE_OPENING_TRADE_ENVS } from './omsEntryPrice';

export class ReflectionEngine {
  private intervalId: NodeJS.Timeout | null = null;
  
  constructor() {
    eventBus.on('TRADE_IDEA_GENERATED', (idea) => this.logPrediction(idea));
  }

  async logPrediction(idea: any) {
    // KronosEngine already logs every forecast via KronosMetrics.recordPrediction() into
    // kronos_predictions (the canonical source evaluateAgents() below reads for this agent) - a
    // second row here, for only the subset that clears the bar to become a real idea, was
    // producing a 2nd/3rd near-duplicate prediction_outcomes grade for the same decision
    // (ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md finding M1). Skip it; the dashboard trajectory
    // chart (KronosDashboardData.ts) reads KronosMetrics' own write, not this one.
    if (idea.agent === 'KronosEngine') return;
    // Real defect fixed (2026-08-26 self-improvement loop audit): the Digital Twin telemetry
    // pulse (core/telemetryPulse.ts - synthetic EventBus sequence for UI animation only) emits
    // raw TRADE_IDEA_GENERATED events on this same event name. ChiefTraderAgent/RiskAgent/
    // OrderManagement already guard against it; this listener did not, so a UI demo run's
    // fabricated 0.82/0.78-confidence TechnicalAgent/QuantEngine "ideas" were logged into
    // agent_predictions as if real, and (confirmed live) two were later graded WIN against real
    // AAPL price action, feeding fabricated evidence into real agentPerformanceStats.currentWeight.
    if (isTelemetryPulsePayload(idea)) return;
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
        // Phase 6/7 - regime at generation time (TechnicalAgent's lightweightRegimeClassifier, or
        // any future agent that starts carrying one); null/absent for agents that don't compute
        // one - never fabricated, never backfilled after the fact.
        regime: idea.regime ?? null,
      });
    } catch (e) {
      console.error("[ReflectionEngine] Error logging prediction:", e);
    }
  }

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.evaluateAgents(), runtimeIntervals.reflectionEngineMs);
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
      // Real defect fixed (2026-08-26 self-improvement loop audit): this previously read ALL
      // trades regardless of execution_environment. Live DB evidence: every single non-null
      // trades.profit_loss row in the entire database (67/67) is execution_environment='REPLAY' -
      // organic PAPER fills have never had profit_loss populated (see the peak-equity recovery
      // report's own finding). That means generateReflectionRule() below - which makes a real
      // LLM call and writes real learned_rules text INTO the live ChiefTrader debate prompt - had
      // structurally never been triggered by real trading experience, only by REPLAY (historical
      // simulation) losses mislabeled "Post-trade drawdown analysis." Restricting to real organic
      // execution environments closes that gap; REPLAY/BACKTEST/SIMULATION/EXTERNAL_SYNC/
      // DIAGNOSTIC continue to be excluded, matching the same organic-only convention already
      // used by omsEntryPrice.ts and the soak-status scripts.
      // Denylist (not allowlist), matching omsEntryPrice.ts's exact convention: a null/blank
      // execution_environment is a legacy pre-tagging row (real trade, no stamp yet), not
      // REPLAY/BACKTEST - it must stay included, only the known-synthetic environments are
      // excluded.
      const allTrades = (await db.select().from(trades).all())
        .filter(t => !NON_LIVE_OPENING_TRADE_ENVS.has(String(t.executionEnvironment || '').toUpperCase()));
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
      // ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md Phase 1/4 - the same
      // outcomes also collected here, per-row, so effective (autocorrelation-clustered) sample
      // size can gate live weight learning below. statsMap/calibrationMap above stay RAW and are
      // never deleted or hidden - only which numbers drive currentWeight changes.
      const rowsByAgent: Record<string, ClusterableRow[]> = {};

      const accumulate = (
        agentName: string, confidence: number, outcome: string, actualReturn: number | null,
        symbol: string, side: string, timestampMs: number, secondaryKey: string | null,
      ) => {
        if (!statsMap[agentName]) statsMap[agentName] = { total: 0, correct: 0, sumReturn: 0 };
        if (!rowsByAgent[agentName]) rowsByAgent[agentName] = [];
        rowsByAgent[agentName].push({ symbol, agent: agentName, side, timestampMs, outcome: outcome as 'WIN' | 'LOSS' | 'N_A', secondaryKey: secondaryKey ?? undefined });
        if (outcome === 'N_A') return; // HOLD-style predictions made no directional call to score
        statsMap[agentName].total += 1;
        const absReturn = Math.abs(actualReturn ?? 0);
        if (outcome === 'WIN') {
          statsMap[agentName].correct += 1;
          statsMap[agentName].sumReturn += absReturn;
        } else {
          statsMap[agentName].sumReturn -= absReturn;
        }

        const bucket = bucketFor(confidence);
        const bucketKey = `${bucket.low}-${bucket.high}`;
        if (!calibrationMap[agentName]) calibrationMap[agentName] = {};
        if (!calibrationMap[agentName][bucketKey]) calibrationMap[agentName][bucketKey] = { wins: 0, losses: 0 };
        if (outcome === 'WIN') calibrationMap[agentName][bucketKey].wins += 1;
        else calibrationMap[agentName][bucketKey].losses += 1;
      };

      // Every agent except KronosEngine logs its own idea via logPrediction() above (one row per
      // real TRADE_IDEA_GENERATED), so agent_predictions + this outcome join is the correct,
      // non-duplicated source for them.
      // Real defect fixed (2026-08-26 self-improvement loop audit): filters out any prediction
      // whose traceId carries the Digital Twin telemetry-pulse prefix (UI demo animation, not a
      // real trading decision) - confirmed live that 2 such fabricated rows had already been
      // graded WIN and were feeding into this exact aggregate. Filtering here means the very next
      // reflection cycle self-corrects agentPerformanceStats/agentConfidenceCalibration forward,
      // with no need to hand-edit already-persisted historical rows.
      const predictions = (await db.select().from(agentPredictions).all())
        .filter(p => !p.traceId || !p.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX));
      const predictionById = new Map(predictions.map(p => [p.id, p]));
      const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));
      for (const o of outcomes) {
        const p = predictionById.get(o.predictionId);
        if (!p || p.agentName === 'KronosEngine') continue; // Kronos sourced from kronos_predictions below - see M1
        accumulate(
          p.agentName, p.confidence, o.outcome, o.actualReturn,
          p.symbol, p.prediction, new Date(p.timestamp).getTime(),
          secondaryGroupKey(p.agentName, p.reasoning),
        );
      }

      // KronosEngine: kronos_predictions is its one real forecast ledger (every tick, no
      // duplication) - source its stats/calibration from there directly instead of the
      // agent_predictions copies (ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md finding M1).
      const kronosRows = await db.select().from(kronosPredictions).all();
      const kronosById = new Map(kronosRows.map(k => [String(k.id), k]));
      const kronosOutcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'kronos_predictions'));
      for (const o of kronosOutcomes) {
        const k = kronosById.get(o.predictionId);
        if (!k) continue;
        accumulate('KronosEngine', k.confidence, o.outcome, o.actualReturn, k.symbol, k.prediction, new Date(k.timestamp).getTime(), null);
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

      for (const [agentName, data] of Object.entries(statsMap)) {
        if (data.total === 0) continue;
        const rawWinRate = data.correct / (data.total || 1);
        const avgReturn = data.sumReturn / (data.total || 1);

        // Phase 4/5/8 - effective (de-duplicated + autocorrelation-clustered) sample, using this
        // agent's own independence policy (Kronos's shorter horizon, Quant's strategy-id secondary
        // key), gates whether there is enough INDEPENDENT evidence to trust a learned weight at
        // all - closes the confirmed gap where raw, correlated counts alone cleared
        // minSampleSizeForTrust by orders of magnitude.
        const rows = rowsByAgent[agentName] ?? [];
        const eff = rawVsEffectiveDirectional(rows, independenceClusterGapMs(agentName));
        const evidenceStatus = classifyEvidenceStatus(eff.effectiveN, tradingSafety.minSampleSizeForTrust);
        const effectiveWinRate = eff.effectiveN > 0 ? eff.effectiveWins / eff.effectiveN : 0;

        const [existingStats] = await db.select().from(agentPerformanceStats).where(eq(agentPerformanceStats.agentName, agentName));
        const previousWeight = existingStats?.currentWeight ?? defaultAgentWeights[agentName] ?? 1.0;

        let newWeight: number;
        let profitFactor = 0;
        let sharpeRatio = 0;
        if (isExcludedFromWeightLearning(agentName)) {
          // Phase 9 - risk-exit agent (e.g. PortfolioManager): stats are still computed and
          // persisted for observability, but a learned "directional call quality" weight is not a
          // meaningful concept for exits, so its live weight never moves from here.
          newWeight = previousWeight;
        } else if (evidenceStatus === 'LEARNING_ELIGIBLE') {
          const weight = agentWeightUpdate({ totalEvaluated: eff.effectiveN, winRate: effectiveWinRate });
          newWeight = boundedStep(previousWeight, weight.currentWeight, tradingSafety.maxWeightAdjustmentPerCycle);
          profitFactor = effectiveWinRate > 0 && effectiveWinRate < 1 ? effectiveWinRate / (1 - effectiveWinRate) : 0;
          sharpeRatio = weight.sharpeRatio;
        } else {
          // Phase 8 - evidence dropped back to insufficient (or never cleared it): gradually roll
          // the live weight back toward this agent's static default rather than leave it frozen at
          // a stale value computed under a since-corrected (or since-noisier) sufficiency read.
          const neutralTarget = defaultAgentWeights[agentName] ?? 1.0;
          newWeight = boundedStep(previousWeight, neutralTarget, tradingSafety.maxWeightAdjustmentPerCycle);
        }

        await db.insert(agentPerformanceStats).values({
          agentName,
          totalPredictions: data.total,
          correctPredictions: data.correct,
          winRate: rawWinRate,
          averageReturn: avgReturn,
          profitFactor,
          sharpeRatio,
          effectivePredictions: eff.effectiveN,
          effectiveCorrect: eff.effectiveWins,
          wilsonLower: eff.effectiveInterval.lower,
          wilsonUpper: eff.effectiveInterval.upper,
          evidenceStatus,
          currentWeight: newWeight,
          lastEvaluated: new Date().toISOString()
        }).onConflictDoUpdate({
          target: agentPerformanceStats.agentName,
          set: {
            totalPredictions: data.total,
            correctPredictions: data.correct,
            winRate: rawWinRate,
            averageReturn: avgReturn,
            profitFactor,
            sharpeRatio,
            effectivePredictions: eff.effectiveN,
            effectiveCorrect: eff.effectiveWins,
            wilsonLower: eff.effectiveInterval.lower,
            wilsonUpper: eff.effectiveInterval.upper,
            evidenceStatus,
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
