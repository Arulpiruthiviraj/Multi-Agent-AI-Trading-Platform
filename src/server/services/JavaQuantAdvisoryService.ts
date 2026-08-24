/**
 * Phase 2 of the Java engine activation plan (docs/audits/ARGUS_POST_MIGRATION_ARCHITECTURE_AUDIT.md,
 * config/engineOwnership.json): gives the previously-zero-consumer Java institutional models
 * (GARCH, HMM regime, factor composite) a real, on-demand consumer.
 *
 * Deliberately advisory-only, matching engineOwnership.json's own notes for these models:
 * - Does NOT call eventBus.emitTradeIdea - only the generic EventBus.emit for observability.
 * - Does NOT import or touch EvidenceAggregator, ChiefTraderAgent, RiskEngine, OrderManagement,
 *   or BrokerManager.
 * - Wiring QUANT_ADVISORY_ANALYSIS_COMPLETED into the consensus vote is Phase 3 of the activation
 *   plan - an explicit, separate, NOT-YET-TAKEN decision. That plan itself warns that Java
 *   evidence must enter as one vote among many, never automatic approval, and that correlated
 *   evidence must not be double-counted - both unresolved design questions this service
 *   deliberately does not attempt to answer by simply existing.
 * - Off entirely unless isQuantJavaCoreEnabled() (same base flag QuantCoreBridge.ts already
 *   gates on) - zero timer, zero network calls, zero-op when disabled.
 * - Fails closed on every real-data dependency (historicalDataGateway, the Java HTTP calls):
 *   any failure just skips that symbol's analysis for this tick, never throws, never fabricates
 *   a result.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { isQuantJavaCoreEnabled } from '../config/tradingSafety';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { quantCoreBridge } from './QuantCoreBridge';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import type { ResearchBar } from '../research/ohlcvTypes';

// Real floor GarchEngine/HmmRegimeEngine themselves enforce (30 returns / 40 observations) plus
// margin - matches this codebase's convention of deriving gate values from the same math the
// callee uses rather than an arbitrary round number. See GarchEngine.fit()/HmmRegimeEngine.fit().
const MIN_BARS_FOR_ANALYSIS = 60;
const LOOKBACK_DAYS = 260;
const TIMEFRAME = '1Day';

class JavaQuantAdvisoryService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;

  start(): void {
    if (this.intervalId || !isQuantJavaCoreEnabled()) return;
    this.intervalId = setInterval(() => {
      this.tick().catch(() => { /* analyzeSymbol already fails closed internally; defense in depth */ });
    }, runtimeIntervals.javaQuantAdvisoryMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async tick(): Promise<void> {
    if (!isQuantJavaCoreEnabled()) return;
    const universe = resolveIdeaUniverse();
    if (universe.length === 0) return;
    const symbol = universe[this.cursor % universe.length];
    this.cursor += 1;
    await this.analyzeSymbol(symbol);
  }

  /** Exported as a standalone step - real per-symbol analysis, callable directly (tests, a future manual trigger) without needing a live timer tick. */
  async analyzeSymbol(symbol: string): Promise<void> {
    if (!isQuantJavaCoreEnabled()) return;
    const startedAt = Date.now();

    let bars: ResearchBar[];
    try {
      const endMs = Date.now();
      const startMs = endMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      await historicalDataGateway.ensureBars(symbol, TIMEFRAME, startMs, endMs);
      bars = await historicalDataGateway.getBars(symbol, TIMEFRAME, startMs, endMs);
    } catch (e) {
      observeSafe(() => {
        structuredLogger.warn('java_quant_advisory_bars_failed', {
          category: 'OBSERVABILITY',
          eventType: 'QUANT_ADVISORY_BARS_FAILED',
          symbol,
          error: e instanceof Error ? e.message : String(e),
        });
      });
      return;
    }
    if (bars.length < MIN_BARS_FOR_ANALYSIS) return;

    const [garch, regime, factor] = await Promise.all([
      quantCoreBridge.fetchInstitutionalVolatility(symbol, bars),
      quantCoreBridge.fetchInstitutionalRegime(symbol, bars),
      quantCoreBridge.fetchInstitutionalFactors(symbol, bars),
    ]);

    const latencyMs = Date.now() - startedAt;
    // Plain EventBus.emit (observability only) - not emitTradeIdea. No agent name, no side, no
    // confidence field shaped like a vote; this is explicitly not a TRADE_IDEA_GENERATED payload.
    eventBus.emit(EVENTS.QUANT_ADVISORY_ANALYSIS_COMPLETED, {
      symbol,
      timestamp: new Date().toISOString(),
      models: { garch, regime, factor, statArb: null },
      health: {
        javaAvailable: garch !== null || regime !== null || factor !== null,
        latencyMs,
      },
    });
  }
}

export const javaQuantAdvisoryService = new JavaQuantAdvisoryService();
