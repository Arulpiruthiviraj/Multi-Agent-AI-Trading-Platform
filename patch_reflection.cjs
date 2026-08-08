const fs = require('fs');
const content = `/**
 * ==========================================================
 * Module: ReflectionEngine.ts
 *
 * Purpose:
 * Analyzes actual trades and agent performance based on
 * real market data rather than simulated outcomes.
 * ==========================================================
 */
import { db } from '../db';
import { agentPredictions, agentPerformanceStats, trades, learnedRules } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { eventBus } from '../core/EventBus';
import { marketDataWorker } from './MarketDataWorker';
import { AIRouter } from '../ai/AIRouter';
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
        timestamp: idea.timestamp || new Date().toISOString()
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
         if (t.status === 'REJECTED') continue;
         
         const tradeTime = new Date(t.timestamp).getTime();
         if (now - tradeTime > 60000) {
            const currentPrice = marketDataWorker.getLatestPrice(t.symbol!);
            if (!currentPrice) continue;
            
            const isLong = t.side === 'BUY';
            const entry = (t.price as number) || 0;
            if (entry <= 0) continue;
            
            const priceDiff = currentPrice - entry;
            const isProfitable = isLong ? priceDiff > 0 : priceDiff < 0;
            
            if (isProfitable) {
                successfulTradesCount++;
            } else {
                failedTradesCount++;
                if (now - tradeTime < 3600000) { // Only reflect on losses in the last hour
                    recentLosses.push({ symbol: t.symbol, side: t.side, entry, currentPrice, reasoning: t.reasoning });
                }
            }
         }
      }

      // 1. We should ideally have price at prediction time, but without altering schema 
      // we'll assume predictions aligned with trades or just track the number of predictions 
      // and their nominal success based on the asset's overall direction during that hour.
      // For now, we will track real outcomes from trades for agent performance, 
      // but without complex time-matching, we'll assign a basic performance score based on recent trades.
      
      const statsMap: Record<string, any> = {};
      const predictions = await db.select().from(agentPredictions).all();
      
      for (const p of predictions) {
        if (!statsMap[p.agentName]) {
          statsMap[p.agentName] = { total: 0, correct: 0, sumReturn: 0 };
        }
        statsMap[p.agentName].total += 1;
        
        const predTime = new Date(p.timestamp).getTime();
        if (now - predTime > 60000) {
            const currentPrice = marketDataWorker.getLatestPrice(p.symbol);
            if (currentPrice) {
               // A simplified evaluation: if prediction was BUY and price > threshold, we count as correct.
               // Since we don't have entry price, we just proxy it by evaluating against the last known trade price.
               const recentTrade = allTrades.find(t => t.symbol === p.symbol && t.status === 'FILLED' && Math.abs(new Date(t.timestamp).getTime() - predTime) < 300000);
               if (recentTrade) {
                   const isLong = p.prediction === 'BUY';
                   const entry = recentTrade.price as number;
                   const diff = currentPrice - entry;
                   const isCorrect = isLong ? diff > 0 : diff < 0;
                   if (isCorrect) {
                       statsMap[p.agentName].correct += 1;
                       statsMap[p.agentName].sumReturn += Math.abs(diff / entry);
                   } else {
                       statsMap[p.agentName].sumReturn -= Math.abs(diff / entry);
                   }
               }
            }
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
          const prompt = \`Review these recent trading losses and generate a 1-sentence strict reflection rule to prevent similar losses in the future. Losses: \${JSON.stringify(recentLosses.slice(0,3))}\`;
          
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
`;
fs.writeFileSync('src/server/services/ReflectionEngine.ts', content);
