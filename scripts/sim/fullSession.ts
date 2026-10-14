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
import fs from 'node:fs';
import { evaluateCertification } from '../../src/server/replay/synthetic/CertificationGate';
import type { TimelineEntry } from '../../src/server/replay/synthetic/DecisionTimeline';
import {
  buildCanonicalFullDaySpec,
  buildTradeLifecycleSpec,
  buildMultiTradeDaySpec,
  buildRestartSpecs,
  buildMatrixSpecs,
} from './fullSessionPlan';

import { runSpecInChild, summarizeResult } from './sessionRunner';

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
  if (only === 'multitrade') {
    const spec = buildMultiTradeDaySpec(`${outDir}/multitrade.json`, Number((process.argv.find((a) => a.startsWith('--seed=')) ?? '--seed=424242').slice(7)), Number((process.argv.find((a) => a.startsWith('--symbols=')) ?? '--symbols=5').slice(10)));
    const r = await runSpecInChild(spec);
    summary.runs.push({ kind: 'multitrade', ok: r.ok, error: r.error ?? null, ...(r.data ? summarizeResult(r.data) : {}) });
  }

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
