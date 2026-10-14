/**
 * Full-session synthetic certification - CHILD process (2026-10-11, Worker H).
 *
 * Same isolation architecture as scripts/sim/marketOpenChild.ts (parent launcher spawns
 * this with every isolation env var set AT SPAWN TIME via child_process's `env` option):
 * env vars exist before this process's own module graph begins executing, so even a
 * hypothetical future static top-level import of a db-touching module would still see the
 * correct isolated ARGUS_DB_PATH. This file is never invoked directly by an operator.
 *
 * Takes --spec=<json> (a FullSessionSpec), runs one SyntheticSessionEngine session with
 * the fault plan, optionally evaluates the certification gate, and writes a JSON result
 * to spec.outputPath. Prints progress to stdout; the machine-readable result is the file.
 */
import path from 'node:path';
import fs from 'node:fs';
// Pure, side-effect-free: never opens a DB/broker/EventBus connection.
import { assertSyntheticSimulationNotOpeningProductionDb } from '../../src/server/db/syntheticSimulationDbGuard';
import { resolveDbDir } from '../../src/server/db/resolveDbDir';
import type { FullSessionSpec } from './fullSessionPlan';

function assertChildEnvironmentIsIsolated(): void {
  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    throw new Error(
      'FATAL: fullSessionChild.ts must be launched by fullSession.ts (the parent launcher) with ' +
      'SYNTHETIC_SIMULATION=true already set at process-spawn time. Refusing to proceed.',
    );
  }
  const requestedDbPath = process.env.ARGUS_DB_PATH;
  if (!requestedDbPath) {
    throw new Error('FATAL: fullSessionChild.ts requires ARGUS_DB_PATH to already be set by its parent process.');
  }
  const dbDir = resolveDbDir(process.platform, fs.existsSync, process.cwd(), path.resolve);
  assertSyntheticSimulationNotOpeningProductionDb(true, requestedDbPath, path.join(dbDir, 'argus.db'));
}

function parseSpecArg(): FullSessionSpec {
  const arg = process.argv.find((a) => a.startsWith('--spec='));
  if (!arg) throw new Error('FATAL: fullSessionChild.ts requires --spec=<json>, provided only by fullSession.ts.');
  return JSON.parse(decodeURIComponent(arg.slice('--spec='.length))) as FullSessionSpec;
}

async function main() {
  assertChildEnvironmentIsIsolated();
  const spec = parseSpecArg();

  const { SyntheticSessionEngine } = await import('../../src/server/replay/synthetic/SyntheticSessionEngine');
  const engine = new SyntheticSessionEngine();
  engine.prepareIsolatedEnvironment({
    simulationId: spec.simulationId,
    scenarioId: spec.scenarioId,
    seed: spec.seed,
  });

  console.log(
    `\n=== Full session: ${spec.label}\n` +
    `    scenario=${spec.scenarioId} seed=${spec.seed} speed=${spec.speed}x ` +
    `duration=${spec.durationMinutes}min symbols=${spec.symbols} ` +
    `faults=${spec.faultPlan.length}${spec.resume ? ` RESUME from bar ${spec.resume.startBarIndex}` : ''}` +
    `${spec.stopAfterBarIndex !== undefined ? ` STOP after bar ${spec.stopAfterBarIndex}` : ''} ` +
    `[child pid=${process.pid}] ===`,
  );

  let wallClockAudit: { stop(): Array<{ file: string; fn: string; calls: number }> } | null = null;
  if (process.env.ARGUS_SYNTH_WALLCLOCK_AUDIT === '1') {
    const { startWallClockAudit } = await import('../../src/server/replay/synthetic/WallClockAudit');
    wallClockAudit = startWallClockAudit();
  }
  const result = await engine.run({
    simulationId: spec.simulationId,
    scenarioId: spec.scenarioId,
    seed: spec.seed,
    speedMultiplier: spec.speed,
    sessionDurationMinutes: spec.durationMinutes,
    universeSize: spec.symbols,
    initialCash: spec.initialCash ?? 100_000,
    riskProfile: spec.riskProfile,
    faultPlan: spec.faultPlan,
    lateMoverConfigs: spec.lateMoverConfigs,
    staleCacheSymbols: spec.staleCacheSymbols,
    stopAfterBarIndex: spec.stopAfterBarIndex,
    stopWhen: spec.stopWhen,
    resume: spec.resume,
  });

  const wallClockCallers = wallClockAudit ? wallClockAudit.stop() : null;
  let certification: any = null;
  if (spec.requireTradeForCertification !== null && !result.stoppedEarly) {
    const { evaluateCertification } = await import('../../src/server/replay/synthetic/CertificationGate');
    // Fault-induced feed interruptions are not part of the scenario's own DATA_INTERRUPTION
    // events - pass them explicitly so ORDER_DURING_OUTAGE is actually checked.
    const outageWindows = (spec.faultPlan ?? [])
      .filter((f: any) => f.kind === 'FEED_INTERRUPTION')
      .map((f: any) => ({
        fromMs: result.sessionStartMs + f.fromBar * 60_000,
        toMs: result.sessionStartMs + ((f.toBar ?? f.fromBar) + 1) * 60_000,
        label: `fault:FEED_INTERRUPTION@${f.fromBar}`,
      }));
    certification = evaluateCertification(result, spec.requireTradeForCertification, { outageWindows });
    console.log(`\nCertification: ${certification.certification} (tradeObserved=${certification.tradeObserved})`);
    if (certification.reason) console.log(`Reason: ${certification.reason}`);
    if (certification.firstBlockingStage) console.log(`First blocking stage: ${certification.firstBlockingStage}`);
  }

  // Broker summary (JSON-safe; the broker itself holds Maps).
  const brokerState = result.broker.exportState();
  const portfolio = await result.broker.portfolio();
  const brokerSummary = {
    cash: brokerState.cash,
    realizedPnl: brokerState.realizedPnl,
    feesPaid: brokerState.feesPaid,
    slippagePaid: brokerState.slippagePaid,
    equity: portfolio.equity,
    positions: brokerState.positions.map((p: any) => ({
      symbol: p.symbol, quantity: p.quantity, entryPrice: p.entryPrice,
      currentPrice: p.currentPrice, unrealizedPnl: p.unrealizedPnl,
    })),
    orderCount: brokerState.orders.length,
    orders: brokerState.orders.map((o: any) => ({
      id: o.id, symbol: o.symbol, side: o.side, type: o.type, status: o.status,
      quantity: o.quantity, filledQuantity: o.filledQuantity, averageFillPrice: o.averageFillPrice,
    })),
    workingOrderCount: brokerState.workingOrders.length,
  };

  const out = {
    type: 'FULL_SESSION_RESULT',
    label: spec.label,
    spec: {
      simulationId: spec.simulationId, scenarioId: spec.scenarioId, seed: spec.seed,
      durationMinutes: spec.durationMinutes, symbols: spec.symbols,
    },
    certification,
    wallClockCallers,
    faultOutcomes: result.faultOutcomes,
    // Full timeline (needed by the parent to merge restart halves and to audit invariants).
    timeline: result.timeline,
    brokerSummary,
    // For the restart-resume half.
    brokerState: result.stoppedEarly ? result.brokerState : null,
    stoppedEarly: result.stoppedEarly,
    stoppedAtBarIndex: result.stoppedAtBarIndex,
    sessionStartMs: result.sessionStartMs,
    sessionEndMs: result.sessionEndMs,
    universe: result.universe,
    newsItemCount: result.newsItems.length,
    memory: {
      rssStartMb: result.memorySamples[0]?.rssMb ?? null,
      rssPeakMb: result.memorySamples.length ? Math.max(...result.memorySamples.map((s) => s.rssMb)) : null,
      rssEndMb: result.memorySamples[result.memorySamples.length - 1]?.rssMb ?? null,
      heapStartMb: result.memorySamples[0]?.heapUsedMb ?? null,
      heapEndMb: result.memorySamples[result.memorySamples.length - 1]?.heapUsedMb ?? null,
    },
    eventLoop: {
      p50: result.eventLoopP50Ms, p95: result.eventLoopP95Ms,
      p99: result.eventLoopP99Ms, max: result.eventLoopMaxMs,
    },
    wallClockDurationMs: result.wallClockDurationMs,
    dbPath: result.dbPath,
    calibrationSeeded: result.calibrationSeedResults.length > 0,
    // 2026-10-11: the idea-generation-gate proof (held-gate sessions fail loud in
    // evaluateCertification). Carried through the child output so the parent/driver
    // and the certification artifact can see it.
    ideaGenerationGateOpen: result.ideaGenerationGateOpen,
  };

  fs.mkdirSync(path.dirname(spec.outputPath), { recursive: true });
  fs.writeFileSync(spec.outputPath, JSON.stringify(out, null, 2));
  console.log(`\nResult written to ${spec.outputPath}`);
  console.log(`Wall-clock: ${(result.wallClockDurationMs / 1000).toFixed(1)}s | ` +
    `timeline events: ${result.timeline.length} | orders: ${brokerSummary.orderCount} | ` +
    `realizedPnl: ${brokerSummary.realizedPnl.toFixed(2)} | faults: ${result.faultOutcomes.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FULL SESSION FAILED (child)', e);
  process.exit(1);
});
