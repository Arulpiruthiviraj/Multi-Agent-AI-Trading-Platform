/**
 * News+Quant Independent-Consensus Round-Trip Certification - CHILD process (2026-10-06 follow-up).
 * Same isolation discipline as scripts/sim/marketOpenChild.ts - never run directly; spawned by
 * newsQuantRoundTrip.ts with every isolation env var already set at process-spawn time.
 */
import path from 'node:path';
import fs from 'node:fs';
import { assertSyntheticSimulationNotOpeningProductionDb } from '../../src/server/db/syntheticSimulationDbGuard';
import { resolveDbDir } from '../../src/server/db/resolveDbDir';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function assertChildEnvironmentIsIsolated(): void {
  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    throw new Error('FATAL: newsQuantRoundTripChild.ts must be launched by newsQuantRoundTrip.ts.');
  }
  const requestedDbPath = process.env.ARGUS_DB_PATH;
  if (!requestedDbPath) throw new Error('FATAL: ARGUS_DB_PATH must already be set by the parent process.');
  const dbDir = resolveDbDir(process.platform, fs.existsSync, process.cwd(), path.resolve);
  assertSyntheticSimulationNotOpeningProductionDb(true, requestedDbPath, path.join(dbDir, 'argus.db'));
}

interface Spec {
  simulationId: string;
  scenarioId: string;
  seed: number;
  duration: number;
  speed: number;
  symbols: number;
  dbPath: string;
}

async function main() {
  assertChildEnvironmentIsIsolated();
  const args = parseArgs(process.argv.slice(2));
  if (!args.spec) throw new Error('FATAL: requires --spec=<json>');
  const spec: Spec = JSON.parse(decodeURIComponent(args.spec));

  const { SyntheticSessionEngine } = await import('../../src/server/replay/synthetic/SyntheticSessionEngine');
  const engine = new SyntheticSessionEngine();
  engine.prepareIsolatedEnvironment({ simulationId: spec.simulationId, scenarioId: spec.scenarioId, seed: spec.seed });

  // Session timing (CERTIFIED_BULLISH_ENTRY_EXIT, seed 20261006, 400min): the known baseline run
  // (ARGUS_EV_RR_LIVE_EMIT_FORENSIC.md §2) produced 79 real triggerMet:true MSFT instances spread
  // densely across the session (45 PULLBACK_CONTINUATION + 34 RANGE_REVERSION, QuantSignalAgent
  // firing every 5 bars = ~80 cycles total). Three injections spread across the session maximize the
  // chance at least one lands while a QuantEngine MSFT idea is independently fresh, without needing
  // to know the exact trigger bars in advance. Point-in-time discipline is enforced by
  // SyntheticInjectableNewsProvider itself (publishedAtMs vs. the session's own simulated clock),
  // and consensus freshness (tradingSafety.consensusIdeaMaxAgeMs = 60s) is measured in REAL wall-
  // clock time (ChiefTraderAgent's recentIdeas.receivedAt uses Date.now()) - this whole 400-bar
  // session completes in a handful of REAL seconds (REAL_MS_BETWEEN_BARS/speedMultiplier pacing),
  // so any one of these three real NewsAgent ideas stays "fresh" together with essentially every
  // QuantEngine idea emitted anywhere else in the same real-time run.
  // Real finding from this script's own first two runs (kept here, not silently edited away):
  // the organic QuantEngine MSFT ideas in THIS scenario/seed are overwhelmingly SELL (49/49
  // observed PULLBACK_CONTINUATION/RANGE_REVERSION signals, zero BUY) - "BULLISH_ENTRY_EXIT"
  // names the scenario's overall price path, not every strategy's side on every bar. ChiefTrader
  // only counts independent GROUPS that agree on the SAME side - a bullish-worded article paired
  // against an organically-SELL QuantEngine idea produces AGENT_DISAGREEMENT and a low blended
  // confidence, never a 2-independent-group approval. The article content below was changed to a
  // genuinely bearish catalyst (real negative FinBERT/keyword-heuristic sentiment, not a
  // hand-picked tradingBias) to pair with the real, organic SELL side QuantEngine is actually
  // voting in this run.
  const sessionStartOffsetsMin = [90, 180, 270];
  const newsInjections = sessionStartOffsetsMin.map((min, idx) => ({
    id: `msft_cloud_miss_${idx}`,
    title: `Microsoft (MSFT) Cloud Growth Miss Triggers Downgrade, Shares Fall (update ${idx + 1})`,
    content:
      `Microsoft Corporation (MSFT) reported a surprise decline in Azure cloud growth this ` +
      `quarter, missing analyst estimates, and several desks issued a fresh downgrade on the ` +
      `stock following the print. Executives cited softening enterprise demand as the primary ` +
      `driver of the drop. (Synthetic certification update #${idx + 1} - distinct fingerprint, same real catalyst.)`,
    symbol: 'MSFT',
    // publishedAtOffsetMinutes resolved to an absolute ms below, once sessionStartMs is known.
    publishedAtOffsetMin: min,
  }));

  console.log(`\n=== Running News+Quant Independent-Consensus Round-Trip Certification: ${spec.scenarioId} (seed=${spec.seed}, speed=${spec.speed}x, duration=${spec.duration}min, symbols=${spec.symbols}) [child pid=${process.pid}] ===`);
  console.log(`DB: ${spec.dbPath}`);

  // sessionStartMs is computed inside the engine from defaultSessionStartMs() when not supplied -
  // pin it explicitly here so this script can resolve publishedAtMs for each injection before run().
  const { defaultSessionStartMs } = await import('../../src/server/replay/synthetic/SyntheticSessionEngine');
  const sessionStartMs = defaultSessionStartMs();

  const result = await engine.run({
    simulationId: spec.simulationId,
    scenarioId: spec.scenarioId,
    seed: spec.seed,
    speedMultiplier: spec.speed,
    sessionDurationMinutes: spec.duration,
    universeSize: spec.symbols,
    sessionStartMs,
    newsInjections: newsInjections.map((n) => ({
      id: n.id, title: n.title, content: n.content, symbol: n.symbol,
      publishedAtMs: sessionStartMs + n.publishedAtOffsetMin * 60_000,
    })),
  });

  console.log(`\n--- Behavioral timeline (${result.timeline.length} events) ---`);
  const { renderTimeline } = await import('../../src/server/replay/synthetic/DecisionTimeline');
  console.log(renderTimeline(result.timeline));

  // --- Structured DB-backed report (B16/B17 style counts), queried directly rather than
  // grepped-from-log, so this script's own report is independently reproducible. ---
  const { db } = await import('../../src/server/db');
  const schema = await import('../../src/server/db/schema');
  const { eq, inArray, like } = await import('drizzle-orm');

  const msftTrades = await db.select().from(schema.trades).where(eq(schema.trades.symbol, 'MSFT'));
  const tradeIds = msftTrades.map((t) => t.id);
  const msftFills = tradeIds.length > 0
    ? await db.select().from(schema.fills).where(inArray(schema.fills.orderId, tradeIds))
    : [];
  const msftRisk = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.symbol, 'MSFT'));
  const newsClusters = await db.select().from(schema.newsClusters).where(like(schema.newsClusters.symbols, '%MSFT%'));
  const chiefConsensusEvents = await db.select().from(schema.eventTraces)
    .where(inArray(schema.eventTraces.eventType, ['CHIEF_CONSENSUS_STARTED', 'CHIEF_CONSENSUS_COMPLETED', 'CHIEF_APPROVED_IDEA']));
  const msftConsensusEvents = chiefConsensusEvents.filter((e) => {
    try { return JSON.parse(e.payload ?? '{}')?.symbol === 'MSFT' || (e.payload ?? '').includes('MSFT'); } catch { return (e.payload ?? '').includes('MSFT'); }
  });

  console.log('\n=== STRUCTURED REPORT ===');
  console.log(`MSFT trades: ${msftTrades.length} (${msftTrades.map((t) => `${t.side}:${t.status}:qty=${t.quantity}:px=${t.price}:pnl=${t.profitLoss ?? 'null'}`).join(' | ')})`);
  console.log(`MSFT fills: ${msftFills.length} (${msftFills.map((f) => `qty=${f.quantity}:px=${f.price}:cumQty=${f.cumulativeQuantity}:posAfter=${f.positionQuantityAfter}:realizedPnl=${f.realizedPnl ?? 'null'}`).join(' | ')})`);
  console.log(`MSFT risk_assessments: ${msftRisk.length} (${msftRisk.map((r) => `${r.side}:approved=${r.approved}:gate=${r.rejectionGate ?? 'none'}`).join(' | ')})`);
  console.log(`news_clusters mentioning MSFT: ${newsClusters.length}`);
  console.log(`event_traces CHIEF_CONSENSUS_*/CHIEF_APPROVED_IDEA mentioning MSFT: ${msftConsensusEvents.length}`);

  const portfolioRows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'MSFT'));
  console.log(`MSFT final portfolio rows: ${portfolioRows.length} (${portfolioRows.map((p: any) => `qty=${p.quantity}:avgPx=${p.averagePrice}`).join(' | ')})`);

  console.log(`\nWall-clock duration: ${(result.wallClockDurationMs / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error('NEWS+QUANT ROUND TRIP FAILED (child)', e);
  process.exit(1);
});
