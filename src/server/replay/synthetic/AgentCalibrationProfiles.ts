/**
 * Agent calibration PROFILES for synthetic certification (2026-10-14, Oct 14 forensic response).
 *
 * Why this exists: every full-session synthetic run before this ran with an EMPTY `agent_confidence_calibration` table, so each agent's RAW
 * signal strength became its decision confidence (`calibrationSampleSize 0`). Candidate session mt22 produced 15 STRONG approvals in 188
 * consensus rounds (max 0.95) while production on Oct 14 produced 2 rounds >= 0.75 in 27,191, because production's agents are calibrated
 * (KronosEngine's 0.8 bucket: 747W/722L -> 0.5108). The synthetic certification was exercising an easier decision system than the one running.
 *
 * Two classes of fixture, deliberately separate and both labeled:
 *   PRODUCTION_OCT14  - the real production calibration table as observed after the Oct 14 session (win/loss counts per agent and confidence
 *                       bucket). A production-faithful run must ABSTAIN when only these agents' evidence is available.
 *   POSITIVE_CAPABILITY - SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY. Strong, well-sampled reliability for the agents named in
 *                       the fixture so a genuinely qualifying setup CAN reach the unchanged 0.75 / two-independent-group bar. It proves pipeline
 *                       capability, never alpha, and is never presented as organic evidence.
 *
 * Calibrated confidence is always COMPUTED with the production function (`calibratedConfidenceForBucket`, Beta-Binomial posterior with the bucket
 * midpoint prior), never hard-coded, so a fixture cannot drift from the production formula. No threshold, gate, weight or authorization is touched.
 */
import { calibratedConfidenceForBucket, CONFIDENCE_BUCKETS } from '../../services/ConfidenceCalibration';
import type { ConfidenceBucket } from '../../services/ConfidenceCalibration';

export interface CalibrationProfileRow { agentName: string; bucketLow: number; wins: number; losses: number }
export type AgentCalibrationProfileName = 'PRODUCTION_OCT14' | 'POSITIVE_CAPABILITY';

/** Production `agent_confidence_calibration` as read from the Oct 14 post-close snapshot (counts only; no identifiers). */
export const PRODUCTION_OCT14_CALIBRATION: CalibrationProfileRow[] = [
  { agentName: 'KronosEngine', bucketLow: 0.0, wins: 12, losses: 7 },
  { agentName: 'KronosEngine', bucketLow: 0.6, wins: 5, losses: 3 },
  { agentName: 'KronosEngine', bucketLow: 0.7, wins: 112, losses: 119 },
  { agentName: 'KronosEngine', bucketLow: 0.8, wins: 747, losses: 722 },
  { agentName: 'TechnicalAgent', bucketLow: 0.0, wins: 7, losses: 29 },
  { agentName: 'TechnicalAgent', bucketLow: 0.6, wins: 9, losses: 19 },
  { agentName: 'TechnicalAgent', bucketLow: 0.7, wins: 1, losses: 1 },
  { agentName: 'TechnicalAgent', bucketLow: 0.8, wins: 0, losses: 1 },
  { agentName: 'QuantEngine', bucketLow: 0.6, wins: 1, losses: 0 },
  { agentName: 'QuantEngine', bucketLow: 0.7, wins: 2, losses: 0 },
  { agentName: 'QuantEngine', bucketLow: 0.8, wins: 0, losses: 58 },
  { agentName: 'QuantEngine', bucketLow: 0.9, wins: 32, losses: 19 },
  { agentName: 'JavaCoreEnsemble', bucketLow: 0.6, wins: 1, losses: 1 },
  { agentName: 'FundamentalAgent', bucketLow: 0.0, wins: 36, losses: 25 },
];

/** Production `agent_performance_stats.current_weight` values observed on Oct 14 (used by consensus weighting). */
export const PRODUCTION_OCT14_WEIGHTS: Record<string, number> = {
  TechnicalAgent: 0.25, FundamentalAgent: 0.2, MacroAgent: 0.1, NewsAgent: 1.078, QuantEngine: 0.15, KronosEngine: 1.045,
  PortfolioManager: 0.6, OpportunityScreener: 0.884, JavaFactorComposite: 1, JavaCoreEnsemble: 1,
};

/** SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY: a well-sampled, genuinely reliable record for the named agents in the high-confidence buckets. */
export const POSITIVE_CAPABILITY_CALIBRATION: CalibrationProfileRow[] = [
  { agentName: 'KronosEngine', bucketLow: 0.8, wins: 160, losses: 40 },
  { agentName: 'TechnicalAgent', bucketLow: 0.8, wins: 160, losses: 40 },
  { agentName: 'QuantEngine', bucketLow: 0.8, wins: 160, losses: 40 },
];

export function calibrationProfileRows(name: AgentCalibrationProfileName): CalibrationProfileRow[] {
  return name === 'PRODUCTION_OCT14' ? PRODUCTION_OCT14_CALIBRATION : POSITIVE_CAPABILITY_CALIBRATION;
}

function bucketOf(row: CalibrationProfileRow): ConfidenceBucket {
  const b = CONFIDENCE_BUCKETS.find((x) => x.low === row.bucketLow);
  if (!b) throw new Error(`No confidence bucket starts at ${row.bucketLow}`);
  return b;
}

export function calibratedValue(row: CalibrationProfileRow): number {
  return calibratedConfidenceForBucket(bucketOf(row), row.wins, row.losses);
}

/** Writes the profile into the (isolated synthetic or test) database's agent_confidence_calibration table. Never call against production. */
export async function seedAgentCalibrationProfile(name: AgentCalibrationProfileName): Promise<{ profile: AgentCalibrationProfileName; rows: number; label: string }> {
  const { db } = await import('../../db');
  const schema = await import('../../db/schema');
  const now = new Date().toISOString();
  const rows = calibrationProfileRows(name);
  for (const r of rows) {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: r.agentName, bucketLow: r.bucketLow, bucketHigh: bucketOf(r).high, wins: r.wins, losses: r.losses,
      calibratedConfidence: calibratedValue(r), lastEvaluated: now,
    });
  }
  return { profile: name, rows: rows.length, label: name === 'PRODUCTION_OCT14' ? 'PRODUCTION_SNAPSHOT_2026_10_14' : 'SYNTHETIC_SEEDED_NON_ORGANIC_CERTIFICATION_FIXTURE_ONLY' };
}

/** Seeds agent_performance_stats.current_weight (consensus weighting) for the production profile; positive-capability keeps the defaults. */
export async function seedAgentWeights(name: AgentCalibrationProfileName): Promise<number> {
  if (name !== 'PRODUCTION_OCT14') return 0;
  const { db } = await import('../../db');
  const schema = await import('../../db/schema');
  const now = new Date().toISOString();
  let n = 0;
  for (const [agentName, currentWeight] of Object.entries(PRODUCTION_OCT14_WEIGHTS)) {
    await db.insert(schema.agentPerformanceStats).values({ agentName, currentWeight, lastEvaluated: now }).onConflictDoUpdate({ target: schema.agentPerformanceStats.agentName, set: { currentWeight, lastEvaluated: now } });
    n++;
  }
  return n;
}

/** Calibration + weights in one call; the result is recorded in the session artifact so a run's decision realism is auditable. */
export async function seedAgentProfile(name: AgentCalibrationProfileName): Promise<{ profile: string; rows: number; weights: number; label: string }> {
  const cal = await seedAgentCalibrationProfile(name);
  const weights = await seedAgentWeights(name);
  return { profile: name, rows: cal.rows, weights, label: cal.label };
}
