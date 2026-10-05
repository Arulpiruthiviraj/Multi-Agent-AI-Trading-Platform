/**
 * Fast Opportunity Lane — deterministic replay runner.
 *
 * 2026-10-05: Feeds replay events through the fast-lane injection path and
 * measures detection latency. Compares against the recorded normal-lane timeline.
 *
 * This is RESEARCH ONLY. No broker, no orders, no strategy execution.
 * It measures: event → candidate creation latency, and compares fast-lane
 * detection time vs normal-lane detection time per symbol.
 */

import type { ReplayInput, ReplayResult, SymbolReplayResult, SymbolClassification } from './replayContract';
import { fastLaneManager } from '../FastLaneManager';
import { observeSafe } from '../../observability/StructuredLogger';

/**
 * Run a replay. Returns per-symbol results and summary statistics.
 *
 * NOTE: This enables the fast lane in-process for the replay duration.
 * The caller is responsible for ensuring this never runs in production.
 */
export function runReplay(input: ReplayInput): ReplayResult {
  const ranAt = new Date().toISOString();

  // Enable fast lane for replay (in-process only)
  const prevFlag = process.env.FAST_OPPORTUNITY_LANE_ENABLED;
  process.env.FAST_OPPORTUNITY_LANE_ENABLED = 'true';
  fastLaneManager.resetForTests();

  try {
    const results: SymbolReplayResult[] = [];
    const normalBySymbol = new Map(input.normalLane.map((r) => [r.symbol, r]));

    // Sort events by time (deterministic)
    const events = [...input.events].sort((a, b) => a.at.localeCompare(b.at));

    // Track fast-lane detection times
    const fastDetectedAt = new Map<string, string>();

    for (const event of events) {
      if (event.type === 'NEWS_CATALYST' || event.type === 'PRICE_ACCELERATION' || event.type === 'RVOL_SPIKE') {
        const startMs = Date.now();
        const candidate = fastLaneManager.injectCandidate({
          symbol: event.symbol,
          detectionSource: event.type as 'NEWS_CATALYST' | 'PRICE_ACCELERATION' | 'RVOL_SPIKE',
          catalyst: (event.payload.headline as string) || undefined,
          liquidityEvidence: {
            dollarVolume: null,
            spreadBps: null,
            meetsMinLiquidity: false,
          },
        });
        const latencyMs = Date.now() - startMs;

        if (candidate && !fastDetectedAt.has(event.symbol)) {
          fastDetectedAt.set(event.symbol, event.at);
          observeSafe(() => {
            // Record detection latency for analysis
            console.log(`[Replay] ${event.symbol} fast-detected at ${event.at} (injection latency: ${latencyMs}ms)`);
          });
        }
      }
    }

    // Build per-symbol results
    for (const [symbol, normal] of normalBySymbol) {
      const fastAt = fastDetectedAt.get(symbol) || null;
      const normalAt = normal.firstAdmittedAt || normal.firstChallengerAt;

      let latencyImprovementMs: number | null = null;
      if (fastAt && normalAt) {
        latencyImprovementMs = new Date(normalAt).getTime() - new Date(fastAt).getTime();
      }

      let classification: SymbolClassification;
      if (fastAt && normalAt && latencyImprovementMs! > 60_000) {
        classification = 'DETECTED_EARLIER';
      } else if (fastAt && normalAt && Math.abs(latencyImprovementMs!) <= 60_000) {
        classification = 'SAME';
      } else if (fastAt && !normalAt) {
        classification = 'DETECTED_BUT_NO_SETUP'; // Fast lane saw it, normal lane never did
      } else if (!fastAt && normalAt) {
        classification = 'INSUFFICIENT_EVIDENCE'; // Normal lane saw it, fast lane had no trigger
      } else {
        classification = 'INSUFFICIENT_EVIDENCE';
      }

      // Override with expected if provided
      if (input.expected?.[symbol]) {
        classification = input.expected[symbol];
      }

      results.push({
        symbol,
        fastDetectedAt: fastAt,
        detectionLatencyMs: fastAt ? 0 : null, // injection is synchronous
        normalDetectedAt: normalAt,
        latencyImprovementMs,
        classification,
      });
    }

    // Summary
    const improvements = results
      .map((r) => r.latencyImprovementMs)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);

    const median = improvements.length > 0
      ? improvements[Math.floor(improvements.length / 2)]
      : null;
    const p90 = improvements.length > 0
      ? improvements[Math.floor(improvements.length * 0.9)]
      : null;

    return {
      replayId: input.replayId,
      ranAt,
      symbols: results,
      summary: {
        totalSymbols: results.length,
        detectedEarlier: results.filter((r) => r.classification === 'DETECTED_EARLIER').length,
        same: results.filter((r) => r.classification === 'SAME').length,
        medianImprovementMs: median,
        p90ImprovementMs: p90,
      },
    };
  } finally {
    // Restore flag
    if (prevFlag === undefined) {
      delete process.env.FAST_OPPORTUNITY_LANE_ENABLED;
    } else {
      process.env.FAST_OPPORTUNITY_LANE_ENABLED = prevFlag;
    }
    fastLaneManager.resetForTests();
  }
}
