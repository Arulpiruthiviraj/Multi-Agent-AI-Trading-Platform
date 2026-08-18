/**
 * ==========================================================
 * Module: services/StrategyEngineShadowRunner
 *
 * Purpose:
 * Timer-driven, settings-gated SHADOW/ANALYSIS_ONLY evaluator for the isolated Strategy Engine
 * (src/server/strategiesEngine/). Follows AutoTradeScheduler.ts's exact idiom: read
 * settings.strategyEngineEnabled fresh every tick, no-op immediately if off, no persistent
 * in-memory "armed" state that could survive a restart in an unintended way.
 *
 * HARD SAFETY INVARIANT, enforced by construction, not just by convention: this file imports
 * NOTHING from OrderManagement.ts, BrokerManager.ts, or any broker adapter. It computes real
 * signals against real bars and writes them to schema.strategyEngineSignals - that is the entire
 * output. It never calls placeOrder, never calls oms.executeOrder, never touches RiskEngine. A
 * dedicated test (StrategyEngineShadowRunner.safety.test.ts) statically greps this file for those
 * symbols and fails the build if any appear, so this guarantee cannot silently regress.
 * ==========================================================
 */
import { randomUUID } from 'crypto';
import { db } from '../db';
import * as schema from '../db/schema';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { buildMarketSnapshotFromBars } from '../strategiesEngine/core/MarketSnapshot';
import { evaluateCondition } from '../strategiesEngine/conditions/evaluateCondition';
import { defaultRegistry } from '../strategiesEngine/index';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { runtimeIntervals } from '../config/runtimeIntervals';

const REAL_MODES = new Set(['SHADOW', 'ANALYSIS_ONLY']);
const BARS_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000; // enough trading days for real SMA200/ADX history

export class StrategyEngineShadowRunner {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    console.log('[StrategyEngineShadowRunner] Started at boot (independent of settings; no-op unless settings.strategyEngineEnabled is true and mode is SHADOW/ANALYSIS_ONLY).');
    this.intervalId = setInterval(() => this.tick().catch(e => console.error('[StrategyEngineShadowRunner] tick failed', e)), runtimeIntervals.strategyEngineShadowMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[StrategyEngineShadowRunner] Stopped.');
    }
  }

  async tick(): Promise<{ ran: boolean; signalsRecorded: number }> {
    const row = (await db.select().from(schema.settings).limit(1))[0];
    if (!row?.strategyEngineEnabled) return { ran: false, signalsRecorded: 0 }; // feature off - no-op, zero behavior change
    const mode = row.strategyEngineMode;
    if (!REAL_MODES.has(mode)) return { ran: false, signalsRecorded: 0 }; // OFF or any not-yet-real mode - no-op

    let activeIds: string[] = [];
    try {
      activeIds = JSON.parse(row.strategyEngineActiveIdsJson || '[]');
    } catch {
      console.warn('[StrategyEngineShadowRunner] strategyEngineActiveIdsJson is not valid JSON - treating as empty (no strategies active) rather than guessing.');
      return { ran: true, signalsRecorded: 0 };
    }
    if (!Array.isArray(activeIds) || activeIds.length === 0) return { ran: true, signalsRecorded: 0 };

    const maxActive = row.strategyEngineMaxActive ?? 25;
    const boundedIds = activeIds.slice(0, maxActive);
    const symbols = ['SPY']; // deliberately minimal in this pass - real multi-symbol tracking is a real next step, not faked here

    let signalsRecorded = 0;
    for (const strategyId of boundedIds) {
      const strategy = defaultRegistry.get(strategyId);
      if (!strategy) continue; // an id in settings that isn't a real registered strategy - skip, don't guess

      for (const symbol of symbols) {
        try {
          const endMs = Date.now();
          const startMs = endMs - BARS_LOOKBACK_MS;
          const bars = await historicalDataGateway.getBars(symbol, '1Day', startMs, endMs);
          if (bars.length < 60) continue; // not enough real history for a meaningful snapshot

          const snapshot = buildMarketSnapshotFromBars(bars, symbol, strategy.metadata.timeframes[0] ?? '1d');
          const entryMet = evaluateCondition(strategy.entryConditions, snapshot);
          const confirmationMet = strategy.confirmationConditions ? evaluateCondition(strategy.confirmationConditions, snapshot) : null;
          if (!entryMet) continue; // only record real, actionable-looking signals - not every non-event

          const reasons: string[] = [`Entry conditions met for ${strategy.name} (${strategy.id}) on ${symbol}.`];
          if (confirmationMet === false) reasons.push('Confirmation conditions did NOT clear.');

          await db.insert(schema.strategyEngineSignals).values({
            id: randomUUID(),
            strategyId: strategy.id,
            strategyName: strategy.name,
            family: strategy.family,
            symbol,
            timeframe: snapshot.timeframe,
            evidenceClass: mode, // 'SHADOW' | 'ANALYSIS_ONLY'
            side: 'BUY', // this engine's condition trees are long-only signals in this pass, matching runBacktest.ts's own convention
            entryMet,
            confirmationMet,
            reasonsJson: JSON.stringify(reasons),
            priceAtSignal: snapshot.price.close,
            timestamp: snapshot.timestamp,
            createdAt: new Date().toISOString(),
          });
          signalsRecorded++;

          // Informational only - EVENTS.STRATEGY_SIGNAL_GENERATED has no subscriber on the live
          // decision path; publishing it cannot influence ChiefTrader/RiskEngine/OMS in any way.
          eventBus.publish(EVENTS.STRATEGY_SIGNAL_GENERATED, {
            strategyId: strategy.id, symbol, mode, timestamp: snapshot.timestamp,
          });
        } catch (e: any) {
          console.warn(`[StrategyEngineShadowRunner] Skipped ${strategyId}/${symbol}: ${e.message}`);
        }
      }
    }

    return { ran: true, signalsRecorded };
  }
}

export const strategyEngineShadowRunner = new StrategyEngineShadowRunner();
