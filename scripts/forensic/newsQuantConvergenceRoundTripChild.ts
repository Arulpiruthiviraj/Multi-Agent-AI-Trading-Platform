/**
 * News+Quant Independent-Consensus Round-Trip Certification - Phase 1 compatible-scenario attempt.
 * CHILD process. Same isolation discipline as newsQuantRoundTripChild.ts - never run directly.
 *
 * Economic story (written before this script was ever run - see SyntheticScenario.ts's own header
 * comment on COMPANY_BULLISH_CATALYST_CONVERGENCE for the full reasoning): a company-specific
 * bullish catalyst on AAPL, landing inside an orderly structural-break repricing that HOLDS (does
 * not mean-revert) through a clean, volume-confirmed uptrend. The article content below is a real,
 * substantive AAPL product-cycle beat - not a hand-picked tradingBias - timed to land inside the
 * scenario's own "clean uptrend" segment (offset 18-220 min), well clear of both the opening gap and
 * the bounded C1-style pullback (10-18 min) so it does not coincide with transient noise.
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
    throw new Error('FATAL: newsQuantConvergenceRoundTripChild.ts must be launched by newsQuantConvergenceRoundTrip.ts.');
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

  const sessionStartOffsetsMin = [40, 90, 150];
  const newsInjections = sessionStartOffsetsMin.map((min, idx) => ({
    id: `aapl_product_beat_${idx}`,
    title: `Apple (AAPL) Reports Strong Product-Cycle Demand, Multiple Desks Raise Price Targets (update ${idx + 1})`,
    content:
      `Apple Inc. (AAPL) disclosed stronger-than-expected demand signals for its latest product ` +
      `cycle this quarter, with several sell-side desks raising price targets and citing broadening ` +
      `unit volumes and services-attach momentum as the primary drivers. Executives described channel ` +
      `inventory as lean heading into the back half of the year. (Synthetic certification update ` +
      `#${idx + 1} - distinct fingerprint, same real catalyst.)`,
    symbol: 'AAPL',
    publishedAtOffsetMin: min,
  }));

  console.log(`\n=== Running News+Quant Convergence Round-Trip Certification: ${spec.scenarioId} (seed=${spec.seed}, speed=${spec.speed}x, duration=${spec.duration}min, symbols=${spec.symbols}) [child pid=${process.pid}] ===`);
  console.log(`DB: ${spec.dbPath}`);

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

  const { db } = await import('../../src/server/db');
  const schema = await import('../../src/server/db/schema');
  const { eq, inArray, like } = await import('drizzle-orm');

  const aaplTrades = await db.select().from(schema.trades).where(eq(schema.trades.symbol, 'AAPL'));
  const tradeIds = aaplTrades.map((t) => t.id);
  const aaplFills = tradeIds.length > 0
    ? await db.select().from(schema.fills).where(inArray(schema.fills.orderId, tradeIds))
    : [];
  const aaplRisk = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.symbol, 'AAPL'));
  const newsClusters = await db.select().from(schema.newsClusters).where(like(schema.newsClusters.symbols, '%AAPL%'));
  const chiefConsensusEvents = await db.select().from(schema.eventTraces)
    .where(inArray(schema.eventTraces.eventType, ['CHIEF_CONSENSUS_STARTED', 'CHIEF_CONSENSUS_COMPLETED', 'CHIEF_APPROVED_IDEA']));
  const aaplConsensusEvents = chiefConsensusEvents.filter((e) => {
    try { return JSON.parse(e.payload ?? '{}')?.symbol === 'AAPL' || (e.payload ?? '').includes('AAPL'); } catch { return (e.payload ?? '').includes('AAPL'); }
  });

  console.log('\n=== STRUCTURED REPORT (AAPL) ===');
  console.log(`AAPL trades: ${aaplTrades.length} (${aaplTrades.map((t) => `${t.side}:${t.status}:qty=${t.quantity}:px=${t.price}:pnl=${t.profitLoss ?? 'null'}`).join(' | ')})`);
  console.log(`AAPL fills: ${aaplFills.length} (${aaplFills.map((f) => `qty=${f.quantity}:px=${f.price}:cumQty=${f.cumulativeQuantity}:posAfter=${f.positionQuantityAfter}:realizedPnl=${f.realizedPnl ?? 'null'}`).join(' | ')})`);
  console.log(`AAPL risk_assessments: ${aaplRisk.length} (${aaplRisk.map((r) => `${r.side}:approved=${r.approved}:gate=${r.rejectionGate ?? 'none'}`).join(' | ')})`);
  console.log(`news_clusters mentioning AAPL: ${newsClusters.length}`);
  console.log(`event_traces CHIEF_CONSENSUS_*/CHIEF_APPROVED_IDEA mentioning AAPL: ${aaplConsensusEvents.length}`);

  const portfolioRows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'AAPL'));
  console.log(`AAPL final portfolio rows: ${portfolioRows.length} (${portfolioRows.map((p: any) => `qty=${p.quantity}:avgPx=${p.averagePrice}`).join(' | ')})`);

  // Pull the real CONSENSUS_TERMINAL_REASON payload for the latest AAPL round, same method the
  // prior MSFT pass used, so independence/confidence claims are backed by real payload data.
  const { and } = await import('drizzle-orm');
  const aaplTerminalReasons = await db.select().from(schema.observabilityEvents)
    .where(and(eq(schema.observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON'), eq(schema.observabilityEvents.symbol, 'AAPL')));
  console.log(`\nCONSENSUS_TERMINAL_REASON events mentioning AAPL: ${aaplTerminalReasons.length}`);
  for (const e of aaplTerminalReasons.slice(-10)) {
    console.log(`  ${e.payload}`);
  }

  console.log(`\nWall-clock duration: ${(result.wallClockDurationMs / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error('NEWS+QUANT CONVERGENCE ROUND TRIP FAILED (child)', e);
  process.exit(1);
});
