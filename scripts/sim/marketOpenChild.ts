/**
 * Synthetic Market Session Simulator - CHILD process (2026-09-14, Step 1 isolation hardening).
 *
 * This file is never invoked directly by an operator - marketOpen.ts (the parent launcher) spawns
 * one of these per scenario run, with every isolation env var (SYNTHETIC_SIMULATION, ARGUS_DB_PATH,
 * PAPER_TRADING_ONLY, ...) already set via child_process's `env` option AT SPAWN TIME - i.e. before
 * this process's own V8/Node runtime has executed a single line of JS, let alone imported a module
 * capable of opening a DB/broker/filesystem connection.
 *
 * Why this exists (real incident, do not relax this architecture): a same-process version of this
 * simulator once had `prepareIsolatedEnvironment()` (a class METHOD, i.e. code that only runs after
 * its enclosing module has already been imported and evaluated) set ARGUS_DB_PATH. A transitively
 * top-level `import { db } from '../../db'` several hops down a different import chain evaluated
 * BEFORE that method ever ran, opening a real connection to the LIVE data/argus.db. The fix at the
 * time (converting every db-touching import to a dynamic import awaited inside run(), strictly after
 * env vars were set) was directionally correct but same-process: it depends on every future
 * contributor never reintroducing a static top-level import of a db-touching module, forever, with
 * no mechanical enforcement of that rule beyond a code comment and the DB-index guard added in
 * src/server/db/syntheticSimulationDbGuard.ts.
 *
 * The separate-process architecture here removes that class of bug structurally rather than by
 * convention: env vars set via `spawn(..., { env })` exist in `process.env` from the moment this
 * child process's runtime starts, before ANY of its own module graph (including this very file)
 * begins executing - so even a hypothetical future static top-level import of a db-touching module
 * would still see the correct isolated ARGUS_DB_PATH already in place. The self-check below is
 * defense-in-depth on top of that structural guarantee (and matches the db/index.ts guard's own
 * fail-loud, fail-before-any-connection contract), not the primary mechanism.
 */
import path from 'node:path';
import fs from 'node:fs';
// Both of these are pure, side-effect-free modules - neither imports `db`, EventBus, or any other
// module that opens a real connection - so importing them statically here, before the isolation
// self-check below runs, is safe. See their own header comments for why they were built this way.
import { assertSyntheticSimulationNotOpeningProductionDb } from '../../src/server/db/syntheticSimulationDbGuard';
import { resolveDbDir } from '../../src/server/db/resolveDbDir';
import type { ScenarioRunSpec } from './simCliArgs';
import { parseArgs } from './simCliArgs';

function assertChildEnvironmentIsIsolated(): void {
  // Mirrors the user-specified pseudocode ordering: assert ARGUS_DB_PATH is isolated -> assert
  // production path cannot be opened -> ONLY THEN import anything capable of booting Argus core.
  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    throw new Error(
      'FATAL: marketOpenChild.ts must be launched by marketOpen.ts (the parent launcher) with ' +
      'SYNTHETIC_SIMULATION=true already set at process-spawn time. Refusing to proceed - this file ' +
      'must never be run directly.',
    );
  }
  const requestedDbPath = process.env.ARGUS_DB_PATH;
  if (!requestedDbPath) {
    throw new Error('FATAL: marketOpenChild.ts requires ARGUS_DB_PATH to already be set by its parent process.');
  }
  const dbDir = resolveDbDir(process.platform, fs.existsSync, process.cwd(), path.resolve);
  assertSyntheticSimulationNotOpeningProductionDb(true, requestedDbPath, path.join(dbDir, 'argus.db'));
}

interface ChildResultMessage {
  type: 'SIMULATION_RESULT';
  certification: 'PASS' | 'FAIL' | null;
  tradeObserved: boolean | null;
  zeroTradeReason: string | null;
  firstBlockingStage: string | null;
  calibrationSeeded: boolean;
}

async function runOneScenario(spec: ScenarioRunSpec): Promise<ChildResultMessage> {
  const { SyntheticSessionEngine } = await import('../../src/server/replay/synthetic/SyntheticSessionEngine');
  const engine = new SyntheticSessionEngine();
  // assertSyntheticSimulationIsolation() (called inside prepareIsolatedEnvironment) is the SECOND
  // independent isolation proof this process performs - the first (above, in
  // assertChildEnvironmentIsIsolated) ran before any Argus module was even imported.
  engine.prepareIsolatedEnvironment({ simulationId: spec.simulationId, scenarioId: spec.scenarioId, seed: spec.seed });
  console.log(`\n=== Running ${spec.scenarioId} (seed=${spec.seed}, speed=${spec.speed}x, duration=${spec.durationMinutes}min, symbols=${spec.symbols}) [child pid=${process.pid}] ===`);
  const result = await engine.run({
    simulationId: spec.simulationId, scenarioId: spec.scenarioId, seed: spec.seed, speedMultiplier: spec.speed,
    sessionDurationMinutes: spec.durationMinutes, universeSize: spec.symbols,
    calibrationSeeds: spec.calibrationSeeds,
  });

  console.log(`\n--- Behavioral timeline (${result.timeline.length} events) ---`);
  const { renderTimeline } = await import('../../src/server/replay/synthetic/DecisionTimeline');
  console.log(renderTimeline(result.timeline));

  if (spec.requireTradeForCertification !== null) {
    const { evaluateCertification, renderCertificationReport } = await import('../../src/server/replay/synthetic/CertificationGate');
    const cert = evaluateCertification(result, spec.requireTradeForCertification);
    console.log('\n' + renderCertificationReport(cert));
    return {
      type: 'SIMULATION_RESULT',
      certification: cert.certification,
      tradeObserved: cert.tradeObserved,
      zeroTradeReason: cert.zeroTradeReason,
      firstBlockingStage: cert.firstBlockingStage,
      calibrationSeeded: cert.calibrationSeeded,
    };
  }

  console.log(`\nWall-clock duration: ${(result.wallClockDurationMs / 1000).toFixed(1)}s`);
  console.log(`Memory samples: ${result.memorySamples.length} (RSS ${result.memorySamples[0]?.rssMb}MB -> ${result.memorySamples[result.memorySamples.length - 1]?.rssMb}MB, heapUsed ${result.memorySamples[0]?.heapUsedMb}MB -> ${result.memorySamples[result.memorySamples.length - 1]?.heapUsedMb}MB)`);
  // Event-loop delay histogram (perf_hooks.monitorEventLoopDelay, already computed by the engine but
  // never previously surfaced to the CLI) - 2026-09-16 certification mandate Section 4/22.
  console.log(`Event-loop delay: p50=${result.eventLoopP50Ms.toFixed(2)}ms p95=${result.eventLoopP95Ms.toFixed(2)}ms p99=${result.eventLoopP99Ms.toFixed(2)}ms max=${result.eventLoopMaxMs.toFixed(2)}ms`);
  return { type: 'SIMULATION_RESULT', certification: null, tradeObserved: null, zeroTradeReason: null, firstBlockingStage: null, calibrationSeeded: result.calibrationSeedResults.length > 0 };
}

async function main() {
  assertChildEnvironmentIsIsolated();

  const args = parseArgs(process.argv.slice(2));
  if (!args.spec) throw new Error('FATAL: marketOpenChild.ts requires --spec=<json>, provided only by marketOpen.ts.');
  const spec: ScenarioRunSpec = JSON.parse(decodeURIComponent(args.spec));

  const message = await runOneScenario(spec);
  if (process.send) process.send(message);
  process.exit(0);
}

main().catch((e) => {
  console.error('SIMULATION FAILED (child)', e);
  process.exit(1);
});
