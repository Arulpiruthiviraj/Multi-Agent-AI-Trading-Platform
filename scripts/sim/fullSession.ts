/**
 * Full-session synthetic certification - PARENT launcher/driver (2026-10-11, Worker H).
 *
 * Runs the full trading-day certification matrix: PREMARKET → OPEN → MORNING → MIDDAY →
 * POWER HOUR → CLOSE → POST_CLOSE, with the scenario fault matrix injected (late mover,
 * stale cache, AI outage/recovery, Jev outage probe, news burst, feed interruption +
 * recovery, mid-session backup, liquidity-cap partial fills, risk-rejection / strategy
 * probes, and a mid-session RESTART across two fresh processes).
 *
 * Architecture: PURE LAUNCHER (same pattern as scripts/sim/marketOpen.ts). This file
 * imports nothing from src/server/ at runtime except provably side-effect-free modules
 * (SessionFaultPlan, CertificationGate, syntheticSimulationPaths - pure data/logic, no
 * DB/EventBus/broker at module-evaluation time). Each session runs in its own CHILD
 * process (fullSessionChild.ts) with isolation env vars set AT SPAWN TIME.
 *
 * Usage:
 *   node --use-system-ca node_modules/tsx/dist/cli.mjs scripts/sim/fullSession.ts --out=/tmp/full-session [--only=canonical|restart|matrix]
 *
 * Writes per-run JSON to --out/ plus combined-summary.json.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeSyntheticSimulationPaths } from '../../src/server/replay/syntheticSimulationPaths';
import { evaluateCertification } from '../../src/server/replay/synthetic/CertificationGate';
import type { TimelineEntry } from '../../src/server/replay/synthetic/DecisionTimeline';
import {
  buildCanonicalFullDaySpec,
  buildTradeLifecycleSpec,
  buildRestartSpecs,
  buildMatrixSpecs,
  type FullSessionSpec,
} from './fullSessionPlan';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildChildEnv(dbPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LIVE_ARM;
  env.SYNTHETIC_SIMULATION = 'true';
  env.PAPER_TRADING_ONLY = 'true';
  env.ARGUS_DB_PATH = dbPath;
  env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';
  env.ARGUS_DISABLE_HEAP_SNAPSHOTS = 'true';
  env.OPENALICE_ENABLED = 'false';
  env.ARGUS_OPPORTUNITY_LOOP_ENABLED = 'false';
  env.ARGUS_BROAD_UNIVERSE_ENABLED = 'false';
  env.ARGUS_MARKET_MOVERS_ENABLED = 'false';
  env.ARGUS_ACTIVE_BROKER = 'internal_paper';
  env.ARGUS_NEWS_ENGINE_ENABLED = 'false';
  env.ARGUS_POST_MARKET_ANALYSIS_ENABLED = 'false';
  // Isolated synthetic session: no real broker/AI keys are ever stored in its DB. When the
  // operator's environment provides no ENCRYPTION_SECRET, use a synthetic-only value (same
  // pattern as vitest.setup.ts) so EncryptionService's fail-closed check passes without
  // touching any real secret. Never logged, never persisted outside the isolated session.
  if (!env.ENCRYPTION_SECRET) {
    env.ENCRYPTION_SECRET = 'SYNTHETIC_SESSION_ONLY_DO_NOT_USE_FOR_REAL_KEYS_2026_10_11';
  }
  return env;
}

interface ChildRunResult {
  ok: boolean;
  outputPath: string;
  data: any | null;
  error?: string;
}

async function runSpecInChild(spec: FullSessionSpec): Promise<ChildRunResult> {
  const { dbPath } = computeSyntheticSimulationPaths(spec.simulationId);
  const env = buildChildEnv(dbPath);
  // Operator-gated cold-start bootstrap: environment control only (the flag is a documented
  // operator gate; ideas still face the full consensus/Risk/OMS path). Set per-spec so the
  // trade-lifecycle run is explicit and auditable.
  if (spec.coldStartBootstrap === true) env.QUANT_COLD_START_BOOTSTRAP_ENABLED = 'true';
  const childScriptPath = path.join(__dirname, 'fullSessionChild.ts');
  const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const specArg = `--spec=${encodeURIComponent(JSON.stringify(spec))}`;
  console.log(`\n>>> launching: ${spec.label} [db=${dbPath}]`);
  const started = Date.now();
  const code: number = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--use-system-ca', tsxCliPath, childScriptPath, specArg], {
      env, stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (c) => resolve(c ?? 1));
  });
  console.log(`<<< finished in ${((Date.now() - started) / 1000).toFixed(1)}s: ${spec.label} (exit=${code})`);
  if (code !== 0) return { ok: false, outputPath: spec.outputPath, data: null, error: `child exit ${code}` };
  try {
    const data = JSON.parse(fs.readFileSync(spec.outputPath, 'utf8'));
    return { ok: true, outputPath: spec.outputPath, data };
  } catch (e: any) {
    return { ok: false, outputPath: spec.outputPath, data: null, error: `result read failed: ${e?.message}` };
  }
}

function summarizeResult(data: any): any {
  const c = data.certification;
  return {
    label: data.label,
    certification: c?.certification ?? null,
    tradeObserved: c?.tradeObserved ?? null,
    stages: c?.stages ?? null,
    firstBlockingStage: c?.firstBlockingStage ?? null,
    reason: c?.reason ?? null,
    zeroTradeReason: c?.zeroTradeReason ?? null,
    realizedPnl: data.brokerSummary?.realizedPnl ?? null,
    orders: data.brokerSummary?.orderCount ?? null,
    fills: c?.counts?.fills ?? null,
    invariantViolations: (c?.invariantViolations ?? []).map((v: any) => v.code),
    faultOutcomes: (data.faultOutcomes ?? []).map((f: any) => ({
      kind: f.kind, phase: f.phase, atBar: f.atBar, verdict: f.verdict, detail: f.detail,
    })),
    wallClockS: +(data.wallClockDurationMs / 1000).toFixed(1),
    eventLoopP95: data.eventLoop?.p95 ?? null,
    rssPeakMb: data.memory?.rssPeakMb ?? null,
  };
}

async function main() {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const outDir = outArg ? outArg.slice('--out='.length) : '/tmp/full-session';
  const only = onlyArg ? onlyArg.slice('--only='.length) : 'all';
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Full-session certification driver. out=${outDir} only=${only}`);

  const summary: any = {
    generatedAt: new Date().toISOString(),
    runs: [] as any[],
  };

  // --- Canonical full day -------------------------------------------------------
  if (only === 'all' || only === 'canonical') {
    const spec = buildCanonicalFullDaySpec(`${outDir}/canonical-full-day.json`);
    const r = await runSpecInChild(spec);
    summary.runs.push({ kind: 'canonical', ok: r.ok, error: r.error ?? null, ...(r.data ? summarizeResult(r.data) : {}) });
  }

  // --- Trade lifecycle (cold-start bootstrap): same environment, full pipeline to fills
  if (only === 'all' || only === 'lifecycle') {
    const spec = buildTradeLifecycleSpec(`${outDir}/trade-lifecycle.json`);
    const r = await runSpecInChild(spec);
    summary.runs.push({ kind: 'lifecycle', ok: r.ok, error: r.error ?? null, ...(r.data ? summarizeResult(r.data) : {}) });
  }

  // --- Restart: two halves, fresh processes, merged certification ---------------
  if (only === 'all' || only === 'restart') {
    const { first, second } = buildRestartSpecs(`${outDir}/restart-half1.json`, `${outDir}/restart-half2.json`);
    const r1 = await runSpecInChild(first);
    let merged: any = null;
    if (r1.ok && r1.data?.brokerState) {
      second.resume = { startBarIndex: 200, brokerState: r1.data.brokerState };
      const r2 = await runSpecInChild(second);
      if (r2.ok) {
        // Merge the two halves' timelines (both stamped on the same synthetic clock) and
        // evaluate the certification gate over the CONTINUOUS session.
        const t1: TimelineEntry[] = r1.data.timeline ?? [];
        const t2: TimelineEntry[] = r2.data.timeline ?? [];
        const mergedTimeline = [...t1, ...t2].sort((a: any, b: any) =>
          (a.simulatedTimeMs ?? 0) - (b.simulatedTimeMs ?? 0) || (a.seq ?? 0) - (b.seq ?? 0),
        );
        // The fault-induced feed interruption (bars 300-309) is not part of the scenario's
        // own DATA_INTERRUPTION events, so pass it explicitly: no order may exist inside it.
        const feedFault = first.faultPlan.find((f: any) => f.kind === 'FEED_INTERRUPTION');
        const outageWindows = feedFault ? [{
          fromMs: r1.data.sessionStartMs + feedFault.fromBar * 60_000,
          toMs: r1.data.sessionStartMs + ((feedFault.toBar ?? feedFault.fromBar) + 1) * 60_000,
          label: 'fault:FEED_INTERRUPTION',
        }] : undefined;
        const pseudoResult: any = {
          simulationId: first.simulationId, scenarioId: first.scenarioId, seed: first.seed,
          timeline: mergedTimeline,
          broker: {
            snapshotCosts: () => ({
              feesPaid: r2.data.brokerSummary.feesPaid,
              slippagePaid: r2.data.brokerSummary.slippagePaid,
              realizedPnl: r2.data.brokerSummary.realizedPnl,
            }),
          },
          costProfile: { commissionPerShare: 0.005, spreadBps: 0, slippageBps: 5 },
          memorySamples: [], eventLoopP50Ms: null, eventLoopP95Ms: null,
          eventLoopP99Ms: null, eventLoopMaxMs: null,
          wallClockDurationMs: r1.data.wallClockDurationMs + r2.data.wallClockDurationMs,
          scenarioId2: first.scenarioId, sessionStartMs: r1.data.sessionStartMs,
          calibrationSeedResults: [],
        };
        const cert = evaluateCertification(pseudoResult, true, { outageWindows });
        merged = {
          certification: cert.certification, tradeObserved: cert.tradeObserved,
          stages: cert.stages, firstBlockingStage: cert.firstBlockingStage,
          reason: cert.reason, realizedPnl: r2.data.brokerSummary.realizedPnl,
          ordersHalf1: r1.data.brokerSummary.orderCount, ordersHalf2: r2.data.brokerSummary.orderCount,
          invariantViolations: cert.invariantViolations.map((v: any) => ({ code: v.code, detail: v.detail })),
          faultOutcomes: [
            ...(r1.data.faultOutcomes ?? []), ...(r2.data.faultOutcomes ?? []),
          ].map((f: any) => ({ kind: f.kind, phase: f.phase, atBar: f.atBar, verdict: f.verdict, detail: f.detail })),
          // Restart-specific integrity checks:
          timelineContinuity: {
            half1Events: t1.length, half2Events: t2.length,
            half1LastTs: t1.length ? (t1[t1.length - 1] as any).simulatedTimeMs ?? null : null,
            half2FirstTs: t2.length ? (t2[0] as any).simulatedTimeMs ?? null : null,
          },
        };
      }
      summary.runs.push({
        kind: 'restart', ok: r1.ok && !!merged, half1Ok: r1.ok,
        half2Ok: !!merged, merged,
        half1: r1.data ? summarizeResult(r1.data) : null,
      });
      if (merged) {
        fs.writeFileSync(`${outDir}/restart-merged.json`, JSON.stringify(merged, null, 2));
      }
    } else {
      summary.runs.push({ kind: 'restart', ok: false, error: r1.error ?? 'first half produced no brokerState' });
    }
  }

  // --- Lighter matrix ------------------------------------------------------------
  if (only === 'all' || only === 'matrix') {
    for (const spec of buildMatrixSpecs(outDir)) {
      const r = await runSpecInChild(spec);
      summary.runs.push({ kind: 'matrix', ok: r.ok, error: r.error ?? null, ...(r.data ? summarizeResult(r.data) : {}) });
    }
  }

  fs.writeFileSync(`${outDir}/combined-summary.json`, JSON.stringify(summary, null, 2));
  console.log(`\n=== combined summary written to ${outDir}/combined-summary.json ===`);
  for (const r of summary.runs) {
    console.log(`- [${r.ok ? 'OK' : 'FAIL'}] ${r.kind}: ${r.label ?? ''} cert=${r.certification ?? 'n/a'}`);
  }
  const failed = summary.runs.filter((r: any) => !r.ok);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FULL SESSION DRIVER FAILED', e);
  process.exit(1);
});
