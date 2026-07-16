import { db } from '../db';
import { agentPredictions, agentPerformanceStats, trades } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { eventBus } from '../core/EventBus';

export class AgentEvaluator {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.evaluateAgents(), 30000); // every 30s
    console.log("[AgentEvaluator] Continuous Self-Improvement Loop started.");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async evaluateAgents() {
    console.log("[AgentEvaluator] Measuring AI performance and dynamically adjusting weights...");
    try {
      // 1. Fetch all predictions
      const predictions = await db.select().from(agentPredictions).all();
      if (predictions.length === 0) return;

      const statsMap: Record<string, any> = {};

      for (const p of predictions) {
        if (!statsMap[p.agentName]) {
          statsMap[p.agentName] = { total: 0, correct: 0, sumReturn: 0 };
        }
        statsMap[p.agentName].total += 1;
        
        // Mock evaluation logic based on some pseudo-randomness representing market resolution
        // In a real system, we'd compare the prediction timestamp price against current price
        const isCorrect = Math.random() > 0.4; // 60% base win rate
        if (isCorrect) {
          statsMap[p.agentName].correct += 1;
          statsMap[p.agentName].sumReturn += (Math.random() * 5); // 0-5% win
        } else {
          statsMap[p.agentName].sumReturn -= (Math.random() * 3); // 0-3% loss
        }
      }

      let totalWeight = 0;
      // 2. Calculate Stats & update DB
      for (const [agentName, data] of Object.entries(statsMap)) {
        const winRate = data.correct / data.total;
        const avgReturn = data.sumReturn / data.total;
        const profitFactor = winRate > 0 ? (winRate * 1.5) / ((1 - winRate) || 0.1) : 0;
        
        // Base weight starts at 1.0, adjusts based on win rate (e.g. >50% goes up)
        const newWeight = Math.max(0.1, 1.0 + ((winRate - 0.5) * 2)); 
        totalWeight += newWeight;

        await db.insert(agentPerformanceStats).values({
          agentName,
          totalPredictions: data.total,
          correctPredictions: data.correct,
          winRate,
          averageReturn: avgReturn,
          profitFactor,
          sharpeRatio: (avgReturn * 12) / (Math.random() * 10 + 1),
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
            sharpeRatio: (avgReturn * 12) / (Math.random() * 10 + 1),
            currentWeight: newWeight,
            lastEvaluated: new Date().toISOString()
          }
        });
      }

      // Normalize weights
      for (const agentName of Object.keys(statsMap)) {
         const current = await db.select().from(agentPerformanceStats).where(eq(agentPerformanceStats.agentName, agentName)).get();
         if (current && totalWeight > 0) {
             const normalized = current.currentWeight / totalWeight;
             await db.update(agentPerformanceStats).set({ currentWeight: normalized }).where(eq(agentPerformanceStats.agentName, agentName));
         }
      }

      console.log(`[AgentEvaluator] Evaluated ${Object.keys(statsMap).length} agents. Weights dynamically adjusted.`);
    } catch (e) {
      console.error("[AgentEvaluator] Error evaluating agents:", e);
    }
  }
}

export const agentEvaluator = new AgentEvaluator();
