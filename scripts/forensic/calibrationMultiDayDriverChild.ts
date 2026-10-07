/**
 * Calibration-Trust Multi-Day Certification - CHILD process. Never run directly - launched by
 * calibrationMultiDayDriver.ts with an isolated ARGUS_DB_PATH already set.
 *
 * See that file's header and docs/audits/ARGUS_CALIBRATION_TRUST_FORENSIC.md's Phases 1-4 for the
 * root cause this exists to work around (a harness-scheduling gap, not a calibration-math defect):
 * PredictionOutcomeEvaluator / ConsensusDebateOutcomeEvaluator / ReflectionEngine /
 * CalibrationValidationWorker are all triggered by a real `setInterval` too slow to ever fire
 * inside a synthetic session's real wall-clock lifetime. This script calls their REAL,
 * UNMODIFIED cycle methods directly (never through `start()`/their own timer), at simulated
 * instants chosen by SyntheticWallClockOverride.ts - it reimplements no grading or calibration
 * formula anywhere.
 *
 * WARMUP_DAYS is frozen here, before this script is ever run, exactly like
 * SyntheticScenario.ts's COMPANY_BULLISH_CATALYST_CONVERGENCE precedent: a deliberate mix of
 * trend/range/reversal/high-volatility days so TechnicalAgent's real win/loss record emerges from
 * real synthetic price action, never tuned after seeing an outcome. Universe is SPY/QQQ only
 * (universeSize=2) - AAPL is deliberately EXCLUDED from every warmup day so no warmup outcome can
 * be read as "the same symbol the target fixture trades." Calibration trust in this codebase is
 * keyed by (agentName, confidence bucket) only (ModerateTierEvaluator.ts / Phase 2 of the prior
 * forensic pass) - never by symbol - so SPY/QQQ evidence is exactly as valid for TechnicalAgent's
 * calibration bucket as AAPL evidence would be, without ever touching AAPL's own price path.
 */
import path from 'node:path';
import fs from 'node:fs';
import { assertSyntheticSimulationNotOpeningProductionDb } from '../../src/server/db/syntheticSimulationDbGuard';
import { resolveDbDir } from '../../src/server/db/resolveDbDir';

function assertChildEnvironmentIsIsolated(): void {
  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    throw new Error('FATAL: calibrationMultiDayDriverChild.ts must be launched by calibrationMultiDayDriver.ts.');
  }
  const requestedDbPath = process.env.ARGUS_DB_PATH;
  if (!requestedDbPath) throw new Error('FATAL: ARGUS_DB_PATH must already be set by the parent process.');
  const dbDir = resolveDbDir(process.platform, fs.existsSync, process.cwd(), path.resolve);
  assertSyntheticSimulationNotOpeningProductionDb(true, requestedDbPath, path.join(dbDir, 'argus.db'));
}

interface WarmupDay {
  label: string;
  scenarioId: string;
  dayOffsetMs: number; // offset from BASE_ANCHOR_MS, spaced >= evaluationHorizonMs apart
}

const BASE_ANCHOR_MS = new Date('2026-01-05T13:30:00.000Z').getTime(); // fixed, deterministic, real weekday - never Date.now()
const DAY_SPACING_MS = 4 * 60 * 60 * 1000; // 4h between day anchors - comfortably clears evaluationHorizonMs (60min)
const SESSION_DURATION_MIN = 400;
const SPEED_MULTIPLIER = 400;
const WARMUP_UNIVERSE_SIZE = 2; // SPY, QQQ only - AAPL deliberately excluded, see header comment
const HORIZON_MS = 3_600_000; // tradingSafety.evaluationHorizonMs - TechnicalAgent uses the default
const MATURITY_BUFFER_MS = 10 * 60 * 1000; // extra margin past the horizon before grading

// Frozen before any run - a deliberate mix of trend/range/reversal/high-volatility days, not
// chosen after seeing an outcome. Each real scenario already exists in SyntheticScenario.ts.
const WARMUP_DAYS: WarmupDay[] = [
  { label: 'Day -10 (trend up)', scenarioId: 'TRENDING_BULL_GAP_AND_GO', dayOffsetMs: 0 * DAY_SPACING_MS },
  { label: 'Day -9  (trend down)', scenarioId: 'TRENDING_BEAR', dayOffsetMs: 1 * DAY_SPACING_MS },
  { label: 'Day -8  (range)', scenarioId: 'SIDEWAYS', dayOffsetMs: 2 * DAY_SPACING_MS },
  { label: 'Day -7  (high volatility)', scenarioId: 'HIGH_VOLATILITY_OPEN', dayOffsetMs: 3 * DAY_SPACING_MS },
  { label: 'Day -6  (quiet)', scenarioId: 'QUIET_OPEN', dayOffsetMs: 4 * DAY_SPACING_MS },
  { label: 'Day -5  (trend up)', scenarioId: 'TRENDING_BULL_GAP_AND_GO', dayOffsetMs: 5 * DAY_SPACING_MS },
  { label: 'Day -4  (trend down)', scenarioId: 'TRENDING_BEAR', dayOffsetMs: 6 * DAY_SPACING_MS },
  { label: 'Day -3  (range)', scenarioId: 'SIDEWAYS', dayOffsetMs: 7 * DAY_SPACING_MS },
  { label: 'Day -2  (high volatility)', scenarioId: 'HIGH_VOLATILITY_OPEN', dayOffsetMs: 8 * DAY_SPACING_MS },
  { label: 'Day -1  (trend up)', scenarioId: 'TRENDING_BULL_GAP_AND_GO', dayOffsetMs: 9 * DAY_SPACING_MS },
];
const TARGET_DAY_OFFSET_MS = 10 * DAY_SPACING_MS; // Day 0 - AAPL target fixture, after all warmup days

interface AgentSampleSnapshot {
  agentName: string;
  predictionsLogged: number;
  outcomesWritten: number;
  wins: number;
  losses: number;
}

async function snapshotAgentSamples(): Promise<AgentSampleSnapshot[]> {
  const { db } = await import('../../src/server/db');
  const schema = await import('../../src/server/db/schema');
  const { eq, and } = await import('drizzle-orm');

  const agents = ['TechnicalAgent', 'QuantEngine', 'NewsAgent', 'KronosEngine'];
  const out: AgentSampleSnapshot[] = [];
  for (const agentName of agents) {
    const preds = await db.select().from(schema.agentPredictions).where(eq(schema.agentPredictions.agentName, agentName));
    const predIds = new Set(preds.map((p) => p.id));
    let outcomesWritten = 0, wins = 0, losses = 0;
    if (predIds.size > 0) {
      const outcomes = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.sourceTable, 'agent_predictions'));
      for (const o of outcomes) {
        if (!predIds.has(o.predictionId)) continue;
        outcomesWritten += 1;
        if (o.outcome === 'WIN') wins += 1;
        if (o.outcome === 'LOSS') losses += 1;
      }
    }
    out.push({ agentName, predictionsLogged: preds.length, outcomesWritten, wins, losses });
  }
  return out;
}

async function snapshotCalibrationRows(): Promise<any[]> {
  const { db } = await import('../../src/server/db');
  const schema = await import('../../src/server/db/schema');
  return db.select().from(schema.agentConfidenceCalibration);
}

async function snapshotChampions(): Promise<any[]> {
  const { db } = await import('../../src/server/db');
  const schema = await import('../../src/server/db/schema');
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.learningVersions).where(eq(schema.learningVersions.status, 'CHAMPION'));
}

async function runOneDay(engine: import('../../src/server/replay/synthetic/SyntheticSessionEngine').SyntheticSessionEngine, simulationId: string, label: string, scenarioId: string, anchorMs: number, universeSize: number, extraNewsInjections: any[] = []): Promise<void> {
  const { withRunningClock, withFrozenClock } = await import('../../src/server/replay/synthetic/SyntheticWallClockOverride');
  console.log(`\n--- ${label}: scenario=${scenarioId} anchor=${new Date(anchorMs).toISOString()} ---`);

  await withRunningClock(anchorMs, async () => {
    // Same engine instance reused across every day of this process - prepareIsolatedEnvironment()
    // was already called once in main() with a fixed simulationId, so this.dbPath/sessionMarkerPath
    // (and therefore ARGUS_DB_PATH) stay identical across every run() call, which is exactly what
    // lets calibration accumulate across days in the SAME DB rather than a fresh one per day.
    const result = await engine.run({
      simulationId,
      scenarioId,
      seed: 20261007,
      speedMultiplier: SPEED_MULTIPLIER,
      sessionDurationMinutes: SESSION_DURATION_MIN,
      universeSize,
      sessionStartMs: anchorMs,
      newsInjections: extraNewsInjections,
    });
    console.log(`  wall-clock: ${(result.wallClockDurationMs / 1000).toFixed(1)}s, universe=${result.universe.join(',')}`);
  });

  // Maturity instant: anchor + horizon + buffer, comfortably past evaluationHorizonMs for every
  // idea created near the start of this session's bar loop. Frozen (not running) - these calls do
  // no further real-time-paced work, only DB reads/writes and real bar lookups keyed by the
  // already-fixed prediction timestamps.
  const matureMs = anchorMs + HORIZON_MS + MATURITY_BUFFER_MS;
  await withFrozenClock(matureMs, async () => {
    const { predictionOutcomeEvaluator } = await import('../../src/server/services/PredictionOutcomeEvaluator');
    const { consensusDebateOutcomeEvaluator } = await import('../../src/server/services/ConsensusDebateOutcomeEvaluator');
    const { reflectionEngine } = await import('../../src/server/services/ReflectionEngine');
    const { runCalibrationValidationCycle } = await import('../../src/server/continuous/CalibrationCandidateBuilder');

    await predictionOutcomeEvaluator.evaluatePending();
    await consensusDebateOutcomeEvaluator.evaluatePending();
    await reflectionEngine.evaluateAgents();
    const promotions = await runCalibrationValidationCycle(new Date(matureMs));
    console.log(`  evaluator cycle run at simulated ${new Date(matureMs).toISOString()}: ${promotions.length} calibration candidates considered`);
  });

  const samples = await snapshotAgentSamples();
  for (const s of samples) {
    if (s.predictionsLogged === 0) continue;
    console.log(`  [${s.agentName}] predictions=${s.predictionsLogged} graded=${s.outcomesWritten} wins=${s.wins} losses=${s.losses}`);
  }
}

async function reportConsensusForSymbol(symbol: string): Promise<{ rawConfidence: number | null; terminalReason: string | null; chiefApproved: boolean }> {
  const { db } = await import('../../src/server/db');
  const schema = await import('../../src/server/db/schema');
  const { eq, and, desc } = await import('drizzle-orm');
  const rows = await db.select().from(schema.observabilityEvents)
    .where(and(eq(schema.observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON'), eq(schema.observabilityEvents.symbol, symbol)))
    .orderBy(desc(schema.observabilityEvents.id));
  const latest = rows[0];
  let rawConfidence: number | null = null;
  let terminalReason: string | null = null;
  if (latest) {
    try {
      const payload = JSON.parse(latest.payload ?? '{}');
      rawConfidence = typeof payload.rawConfidence === 'number' ? payload.rawConfidence
        : typeof payload.finalConfidence === 'number' ? payload.finalConfidence : null;
      terminalReason = payload.moderateReasonCode ?? payload.terminalReason ?? latest.payload;
    } catch {
      terminalReason = latest.payload;
    }
  }
  const approvals = await db.select().from(schema.eventTraces).where(eq(schema.eventTraces.eventType, 'CHIEF_APPROVED_IDEA'));
  const chiefApproved = approvals.some((e) => (e.payload ?? '').includes(symbol));
  return { rawConfidence, terminalReason, chiefApproved };
}

async function main() {
  assertChildEnvironmentIsIsolated();
  const mode = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1];
  if (mode !== 'cold' && mode !== 'warm') throw new Error('FATAL: --mode=cold|warm required');

  console.log(`\n=== Calibration Multi-Day Driver: mode=${mode} pid=${process.pid} ===`);

  const { SyntheticSessionEngine } = await import('../../src/server/replay/synthetic/SyntheticSessionEngine');
  const engine = new SyntheticSessionEngine();
  const simulationId = `calibration_multiday_${mode}_20261007`;
  engine.prepareIsolatedEnvironment({ simulationId, scenarioId: 'QUIET_OPEN', seed: 20261007 });
  console.log(`DB: ${process.env.ARGUS_DB_PATH}`);

  if (mode === 'warm') {
    for (const day of WARMUP_DAYS) {
      await runOneDay(engine, simulationId, day.label, day.scenarioId, BASE_ANCHOR_MS + day.dayOffsetMs, WARMUP_UNIVERSE_SIZE);
    }
    console.log('\n=== WARMUP COMPLETE - per-agent calibration rows now in agent_confidence_calibration ===');
    const calRows = await snapshotCalibrationRows();
    for (const r of calRows) {
      console.log(`  [${r.agentName}] bucket ${r.bucketLow}-${r.bucketHigh} wins=${r.wins} losses=${r.losses} calibratedConfidence=${r.calibratedConfidence.toFixed(4)}`);
    }
    const champions = await snapshotChampions();
    console.log(`  CHAMPION rows: ${champions.length}`);
    for (const c of champions) console.log(`    ${c.versionType} sampleSize=${c.sampleSize} state=${c.stateJson}`);
  }

  // Target day: AAPL COMPANY_BULLISH_CATALYST_CONVERGENCE fixture, same seed/news as the existing
  // committed cold fixture (ARGUS_NEWS_QUANT_INDEPENDENT_ROUNDTRIP_CERTIFICATION.md's 2026-10-07
  // follow-up section).
  const targetAnchor = mode === 'warm' ? BASE_ANCHOR_MS + TARGET_DAY_OFFSET_MS : new Date('2026-09-15T13:30:00.000Z').getTime();
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
    publishedAtMs: targetAnchor + min * 60_000,
  }));

  await runOneDay(engine, simulationId, `Target day (${mode})`, 'COMPANY_BULLISH_CATALYST_CONVERGENCE', targetAnchor, 5, newsInjections);

  console.log(`\n=== STRUCTURED REPORT (${mode}, AAPL) ===`);
  const { isAgentBucketCalibrationTrustworthy } = await import('../../src/server/continuous/ModerateTierEvaluator');
  const { rawConfidence, terminalReason, chiefApproved } = await reportConsensusForSymbol('AAPL');
  console.log(`  rawConfidence=${rawConfidence}`);
  console.log(`  terminalReason=${terminalReason}`);
  console.log(`  CHIEF_APPROVED_IDEA for AAPL: ${chiefApproved}`);
  if (rawConfidence !== null) {
    const trust = await isAgentBucketCalibrationTrustworthy('TechnicalAgent', rawConfidence);
    console.log(`  TechnicalAgent calibration trust @ bucket for rawConfidence=${rawConfidence}: trustworthy=${trust.trustworthy} championEffectiveN=${trust.championEffectiveN} reason=${trust.reason}`);
  }
  const finalSamples = await snapshotAgentSamples();
  for (const s of finalSamples) {
    console.log(`  [FINAL ${s.agentName}] predictions=${s.predictionsLogged} graded=${s.outcomesWritten} wins=${s.wins} losses=${s.losses}`);
  }

  console.log(`\n=== Mode ${mode} complete ===`);
  process.exit(0);
}

main().catch((e) => { console.error(`CALIBRATION MULTI-DAY DRIVER FAILED (child, mode)`, e); process.exit(1); });
