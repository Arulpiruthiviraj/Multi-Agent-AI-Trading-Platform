/**
 * Prediction accuracy status — read-only. Never invents outcomes, never places orders.
 *
 * Reports directional accuracy per agent/secondaryKey/confidence-bucket with BOTH raw sample
 * counts and effective (autocorrelation-clustered) sample counts + Wilson 95% intervals side by
 * side, per ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md's finding that raw prediction_outcomes row
 * counts overstate real independent sample size by 21x-770x for tick-driven agents. Never silently
 * replaces raw with effective - both are always shown.
 *
 * ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md Phase 10: groups QuantEngine by
 * its secondaryGroupKey (real strategy id, or COLD_START_BOOTSTRAP) so the cold-start bootstrap
 * idea's statistics are never blended with EV-backed strategy statistics in this report - the one
 * place they CAN be kept fully separate. `agent_performance_stats.currentWeight` itself remains a
 * single per-agent scalar (ChiefTraderAgent's live weight lookup has no per-strategy concept at
 * all - a structural fact of the existing, protected consensus architecture, not something this
 * pass changes), so this script is the tool for verifying the bootstrap idea isn't quietly
 * dominating QuantEngine's blended live weight even though it can't be fully un-blended there.
 *
 * Usage: npx tsx scripts/prediction_accuracy_status.ts
 */
import dotenv from 'dotenv';
dotenv.config();

function bucketFor(confidence: number): string {
  if (confidence < 0.5) return '<0.50';
  if (confidence < 0.6) return '0.50-0.59';
  if (confidence < 0.7) return '0.60-0.69';
  if (confidence < 0.8) return '0.70-0.79';
  if (confidence < 0.9) return '0.80-0.89';
  return '0.90-1.00';
}

async function main() {
  const { db } = await import('../src/server/db');
  const schema = await import('../src/server/db/schema');
  const { eq } = await import('drizzle-orm');
  const { rawVsEffectiveDirectional } = await import('../src/server/research/effectiveSampleSize');
  const { independenceClusterGapMs, secondaryGroupKey } = await import('../src/server/research/predictionIndependencePolicy');

  // KronosEngine is evaluated exclusively from kronos_predictions - agent_predictions rows for it
  // are a dashboard-only duplicate that PredictionOutcomeEvaluator no longer evaluates (see
  // ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md finding M1).
  const kronosOutcomes = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.sourceTable, 'kronos_predictions'));
  const kronosRows = await db.select().from(schema.kronosPredictions);
  const kronosById = new Map(kronosRows.map((k) => [String(k.id), k]));

  const otherOutcomes = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.sourceTable, 'agent_predictions'));
  const agentRows = await db.select().from(schema.agentPredictions);
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  type Row = { symbol: string; agent: string; side: string; timestampMs: number; outcome: 'WIN' | 'LOSS' | 'N_A'; confidence: number; secondaryKey: string | null };
  const rows: Row[] = [];

  for (const o of kronosOutcomes) {
    const k = kronosById.get(o.predictionId);
    if (!k) continue;
    rows.push({ symbol: k.symbol, agent: 'KronosEngine', side: k.prediction, timestampMs: new Date(k.timestamp).getTime(), outcome: o.outcome as any, confidence: k.confidence, secondaryKey: null });
  }
  for (const o of otherOutcomes) {
    const a = agentById.get(o.predictionId);
    if (!a || a.agentName === 'KronosEngine') continue; // legacy rows pre-dating the M1 fix, if any remain
    rows.push({
      symbol: a.symbol, agent: a.agentName, side: a.prediction, timestampMs: new Date(a.timestamp).getTime(),
      outcome: o.outcome as any, confidence: a.confidence, secondaryKey: secondaryGroupKey(a.agentName, a.reasoning),
    });
  }

  const byGroup = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.agent}|${r.secondaryKey ?? ''}|${bucketFor(r.confidence)}`;
    const list = byGroup.get(key) ?? [];
    list.push(r);
    byGroup.set(key, list);
  }

  const out: any[] = [];
  for (const [key, groupRows] of byGroup) {
    const [agent, secondaryKey, bucket] = key.split('|');
    const result = rawVsEffectiveDirectional(
      groupRows.map((r) => ({ symbol: r.symbol, agent: r.agent, side: r.side, timestampMs: r.timestampMs, outcome: r.outcome, secondaryKey: r.secondaryKey ?? undefined })),
      independenceClusterGapMs(agent),
    );
    out.push({
      agent,
      secondaryKey: secondaryKey || null,
      confidenceBucket: bucket,
      rawN: result.rawN,
      rawWinRate: result.rawInterval.pointEstimate,
      rawWilson95: result.rawInterval.lower !== null ? [result.rawInterval.lower, result.rawInterval.upper] : null,
      effectiveN: result.effectiveN,
      effectiveWinRate: result.effectiveInterval.pointEstimate,
      effectiveWilson95: result.effectiveInterval.lower !== null ? [result.effectiveInterval.lower, result.effectiveInterval.upper] : null,
      inflationFactor: result.inflationFactor,
    });
  }
  out.sort((a, b) => b.rawN - a.rawN);

  const bootstrapRows = out.filter((o) => o.secondaryKey === 'COLD_START_BOOTSTRAP');
  const strategyRows = out.filter((o) => o.agent === 'QuantEngine' && o.secondaryKey && o.secondaryKey !== 'COLD_START_BOOTSTRAP');

  console.log(JSON.stringify({
    ok: true,
    note: 'Read-only. rawN/effectiveN both shown always - never silently substituted. Per-agent independenceClusterGapMs (Kronos: 5min, others: 60min). QuantEngine broken out by real strategy id vs COLD_START_BOOTSTRAP - never blended in this report, though agent_performance_stats.currentWeight remains a single per-agent scalar (ChiefTraderAgent has no per-strategy weight concept). See ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md and ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md.',
    quantColdStartBootstrap: {
      buckets: bootstrapRows,
      summary: bootstrapRows.length === 0 ? 'No bootstrap ideas observed yet.' : `${bootstrapRows.reduce((s, r) => s + r.rawN, 0)} raw / ${bootstrapRows.reduce((s, r) => s + r.effectiveN, 0)} effective bootstrap-idea outcomes recorded, kept separate from EV-backed strategy stats below.`,
    },
    quantEvBackedStrategies: strategyRows,
    buckets: out,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
