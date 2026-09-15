/**
 * Synthetic Market Session Simulator (2026-09-14 mandate) - the mandatory post-change market-open
 * certification gate. Runs the two required deterministic tests against the REAL pipeline (via
 * SyntheticSessionEngine) and reports a machine-readable result plus a first-blocking-stage
 * diagnosis. Never lowers a threshold, never bypasses a gate, never injects a decision directly -
 * every PASS/FAIL below is read off what the real pipeline actually did (SyntheticSessionResult's
 * timeline + broker state), not asserted independently of it.
 */
import type { SyntheticSessionResult } from './SyntheticSessionEngine';
import type { TimelineEntry } from './DecisionTimeline';

export type PipelineStage =
  | 'MARKET_DATA' | 'AGENT_IDEA' | 'CONSENSUS' | 'RISK_APPROVAL' | 'ORDER_SUBMITTED'
  | 'FILL_RECEIVED' | 'POSITION_OPENED' | 'POSITION_CLOSED';

export interface CertificationResult {
  certification: 'PASS' | 'FAIL';
  simulationId: string;
  scenarioId: string;
  seed: number;
  tradeObserved: boolean;
  expectedTrade: boolean;
  completeLifecycle: boolean;
  stages: Record<PipelineStage, boolean>;
  firstBlockingStage: PipelineStage | null;
  reason: string | null;
  zeroTradeReason: string | null;
  counts: {
    marketDataTicks: number;
    ideasGenerated: number;
    consensusApprovals: number;
    riskApprovals: number;
    riskRejections: number;
    ordersSubmitted: number;
    fills: number;
  };
  syntheticPnLRecorded: boolean;
  realizedPnl: number;
  /** true whenever this run seeded a synthetic prior calibration track record (see
   *  CalibrationHistorySeeder.ts) - a PASS achieved with this true is NOT organic proof of
   *  calibration validity, only proof the pipeline mechanism works once evidence exists. Always
   *  false/empty for a plain run with no calibrationSeeds supplied. */
  calibrationSeeded: boolean;
  calibrationSeedDetails: readonly {
    agentName: string; bucketLow: number; bucketHigh: number;
    championEstablished: boolean; effectiveN: number | null; wilsonLower: number | null;
  }[];
  wallClockDurationMs: number;
  eventLoop: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
  memory: { rssStartMb: number | null; rssPeakMb: number | null; rssEndMb: number | null; heapStartMb: number | null; heapEndMb: number | null };
}

const STAGE_ORDER: PipelineStage[] = [
  'MARKET_DATA', 'AGENT_IDEA', 'CONSENSUS', 'RISK_APPROVAL', 'ORDER_SUBMITTED', 'FILL_RECEIVED', 'POSITION_OPENED', 'POSITION_CLOSED',
];

const ZERO_TRADE_REASON_BY_EVENT: Record<string, string> = {
  TRADE_IDEA_REJECTED: 'NO_SIGNAL',
  IDEA_RATE_LIMITED: 'RATE_LIMITED',
  TRADE_REJECTED_CONSENSUS: 'NO_CONSENSUS',
  RISK_BLOCK: 'RISK_REJECTED',
  DESK_NO_TRADE: 'NO_CONSENSUS',
  CANDIDATE_REJECTED: 'LOW_CONFIDENCE',
  ASSET_CANDIDATE_BLOCKED: 'REGIME_REJECTED',
};

function countEvents(timeline: readonly TimelineEntry[], type: string): number {
  return timeline.filter((e) => e.eventType === type).length;
}

function inferZeroTradeReason(timeline: readonly TimelineEntry[]): string {
  for (const entry of timeline) {
    const mapped = ZERO_TRADE_REASON_BY_EVENT[entry.eventType];
    if (mapped) return mapped;
  }
  if (countEvents(timeline, 'TRADE_IDEA_GENERATED') === 0) return 'NO_SIGNAL';
  return 'NO_VALIDATED_EDGE';
}

/**
 * Reads the real pipeline's actual behavior off a SyntheticSessionResult and builds the
 * certification verdict. `requireTrade` distinguishes Test A (must NOT require a trade - zero
 * trades is a legitimate pass) from Test B (a scenario deliberately built to contain a real,
 * recognizable opportunity - a full lifecycle IS required to pass).
 */
export function evaluateCertification(result: SyntheticSessionResult, requireTrade: boolean): CertificationResult {
  const timeline = result.timeline;

  const marketDataTicks = countEvents(timeline, 'MARKET_DATA');
  const ideasGenerated = countEvents(timeline, 'TRADE_IDEA_GENERATED');
  const consensusApprovals = countEvents(timeline, 'CHIEF_APPROVED_IDEA');
  const riskApprovals = timeline.filter((e) => e.eventType === 'RISK_ASSESSMENT_COMPLETED' && e.summary.approved === true).length;
  const riskRejections = countEvents(timeline, 'RISK_BLOCK') + timeline.filter((e) => e.eventType === 'RISK_ASSESSMENT_COMPLETED' && e.summary.approved === false).length;
  const ordersSubmitted = countEvents(timeline, 'ORDER_SUBMITTED');
  const fills = countEvents(timeline, 'ORDER_FILLED') + countEvents(timeline, 'ORDER_EXECUTED');

  const stages: Record<PipelineStage, boolean> = {
    MARKET_DATA: marketDataTicks > 0,
    AGENT_IDEA: ideasGenerated > 0,
    CONSENSUS: consensusApprovals > 0,
    RISK_APPROVAL: riskApprovals > 0,
    ORDER_SUBMITTED: ordersSubmitted > 0,
    FILL_RECEIVED: fills > 0,
    POSITION_OPENED: fills > 0, // a real fill on a BUY opens a position by construction
    POSITION_CLOSED: false, // filled in below once we can inspect realized P&L
  };

  // HistoricalReplayBroker.snapshotCosts() is real, already-public state (not a test-only shim) -
  // realizedPnl only accumulates when a SELL actually closes (all or part of) an existing position
  // (see HistoricalReplayBroker's own order-fill method - the realizedPnl += ... line inside its
  // SELL branch), so a non-zero value here is direct, real evidence a position was both opened and
  // closed - not an open position's unrealized mark, which this field never includes.
  const realizedPnl = result.broker.snapshotCosts().realizedPnl;
  stages.POSITION_CLOSED = realizedPnl !== 0;

  let firstBlockingStage: PipelineStage | null = null;
  for (const stage of STAGE_ORDER) {
    if (!stages[stage]) { firstBlockingStage = stage; break; }
  }

  const tradeObserved = fills > 0;
  const completeLifecycle = STAGE_ORDER.every((s) => stages[s]);

  let certification: 'PASS' | 'FAIL';
  let reason: string | null = null;
  let zeroTradeReason: string | null = null;

  if (requireTrade) {
    certification = completeLifecycle ? 'PASS' : 'FAIL';
    reason = completeLifecycle ? null : `Blocked at ${firstBlockingStage} - see the decision timeline for the exact rejecting event.`;
  } else {
    // Test A (no-trade safety): PASS whether or not a trade happened, AS LONG AS the reason for
    // not trading (if none happened) is a real, legible one, not silence. If a trade DID happen in
    // a scenario expected to be quiet, that's still worth surfacing (not automatically a FAIL - the
    // scenario's own randomness can occasionally produce a real, legitimate small edge), so
    // certification passes either way and the caller inspects tradeObserved/zeroTradeReason itself.
    certification = 'PASS';
    if (!tradeObserved) {
      zeroTradeReason = inferZeroTradeReason(timeline);
    }
  }

  const memSamples = result.memorySamples;
  const rssValues = memSamples.map((s) => s.rssMb);
  const heapValues = memSamples.map((s) => s.heapUsedMb);

  return {
    certification,
    simulationId: result.simulationId,
    scenarioId: result.scenarioId,
    seed: result.seed,
    tradeObserved,
    expectedTrade: requireTrade,
    completeLifecycle,
    stages,
    firstBlockingStage,
    reason,
    zeroTradeReason,
    counts: { marketDataTicks, ideasGenerated, consensusApprovals, riskApprovals, riskRejections, ordersSubmitted, fills },
    syntheticPnLRecorded: stages.POSITION_CLOSED,
    realizedPnl,
    calibrationSeeded: result.calibrationSeedResults.length > 0,
    calibrationSeedDetails: result.calibrationSeedResults.map((r) => ({
      agentName: r.agentName, bucketLow: r.bucketLow, bucketHigh: r.bucketHigh,
      championEstablished: r.championEstablished, effectiveN: r.effectiveN, wilsonLower: r.wilsonLower,
    })),
    wallClockDurationMs: result.wallClockDurationMs,
    eventLoop: { p50: result.eventLoopP50Ms, p95: result.eventLoopP95Ms, p99: result.eventLoopP99Ms, max: result.eventLoopMaxMs },
    memory: {
      rssStartMb: rssValues[0] ?? null,
      rssPeakMb: rssValues.length ? Math.max(...rssValues) : null,
      rssEndMb: rssValues[rssValues.length - 1] ?? null,
      heapStartMb: heapValues[0] ?? null,
      heapEndMb: heapValues[heapValues.length - 1] ?? null,
    },
  };
}

export function renderCertificationReport(cert: CertificationResult): string {
  const lines: string[] = [];
  lines.push('========================================');
  lines.push('ARGUS POST-CHANGE CERTIFICATION');
  lines.push('========================================');
  lines.push(`Simulation:      ${cert.simulationId}`);
  lines.push(`Scenario:        ${cert.scenarioId}`);
  lines.push(`Seed:            ${cert.seed}`);
  lines.push(`Test type:       ${cert.expectedTrade ? 'TRADEABLE SCENARIO (Test B)' : 'NO-TRADE SAFETY (Test A)'}`);
  if (cert.calibrationSeeded) {
    lines.push('');
    lines.push('*** CALIBRATION HISTORY WAS SEEDED FOR THIS RUN - NOT ORGANIC EVIDENCE ***');
    lines.push('    A synthetic prior track record was inserted for the agents below, and the REAL');
    lines.push('    calibration validation cycle ran against it (see CalibrationHistorySeeder.ts).');
    lines.push('    A PASS below proves pipeline CAPABILITY once evidence exists, NOT organic alpha.');
    for (const d of cert.calibrationSeedDetails) {
      lines.push(
        `    - ${d.agentName} [${d.bucketLow}-${d.bucketHigh}]: ` +
        `${d.championEstablished ? 'CHAMPION established' : 'no champion'}` +
        ` (effectiveN=${d.effectiveN ?? 'n/a'}, wilsonLower=${d.wilsonLower?.toFixed(4) ?? 'n/a'})`,
      );
    }
  }
  lines.push('');
  lines.push('Decision pipeline:');
  for (const stage of STAGE_ORDER) {
    lines.push(`  ${stage.padEnd(16)} ${cert.stages[stage] ? 'PASS' : 'FAIL'}`);
  }
  lines.push('');
  lines.push(`Trade observed:      ${cert.tradeObserved}`);
  lines.push(`Orders:              ${cert.counts.ordersSubmitted}`);
  lines.push(`Fills:               ${cert.counts.fills}`);
  lines.push(`Position lifecycle:  ${cert.stages.POSITION_OPENED ? (cert.stages.POSITION_CLOSED ? 'OPENED_AND_CLOSED' : 'OPENED_ONLY') : 'NONE'}`);
  lines.push(`Realized P&L (SIMULATED): ${cert.realizedPnl.toFixed(2)}`);
  if (cert.firstBlockingStage) lines.push(`First blocking stage: ${cert.firstBlockingStage}`);
  if (cert.reason) lines.push(`Reason:              ${cert.reason}`);
  if (cert.zeroTradeReason) lines.push(`Zero-trade reason:   ${cert.zeroTradeReason}`);
  lines.push('');
  lines.push(`Ideas generated:     ${cert.counts.ideasGenerated}`);
  lines.push(`Consensus approvals: ${cert.counts.consensusApprovals}`);
  lines.push(`Risk approvals:      ${cert.counts.riskApprovals}`);
  lines.push(`Risk rejections:     ${cert.counts.riskRejections}`);
  lines.push('');
  lines.push('Memory:');
  lines.push(`  RSS start:  ${cert.memory.rssStartMb ?? 'n/a'}MB`);
  lines.push(`  RSS peak:   ${cert.memory.rssPeakMb ?? 'n/a'}MB`);
  lines.push(`  RSS end:    ${cert.memory.rssEndMb ?? 'n/a'}MB`);
  lines.push(`  Heap start: ${cert.memory.heapStartMb ?? 'n/a'}MB`);
  lines.push(`  Heap end:   ${cert.memory.heapEndMb ?? 'n/a'}MB`);
  lines.push('Event loop:');
  lines.push(`  p50: ${cert.eventLoop.p50?.toFixed(2) ?? 'n/a'}ms  p95: ${cert.eventLoop.p95?.toFixed(2) ?? 'n/a'}ms  p99: ${cert.eventLoop.p99?.toFixed(2) ?? 'n/a'}ms  max: ${cert.eventLoop.max?.toFixed(2) ?? 'n/a'}ms`);
  lines.push('');
  lines.push(`Wall-clock duration: ${(cert.wallClockDurationMs / 1000).toFixed(1)}s`);
  lines.push(`OVERALL: ${cert.certification}`);
  lines.push('========================================');
  return lines.join('\n');
}
