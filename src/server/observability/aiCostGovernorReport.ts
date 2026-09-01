/**
 * AI Cost Governor observability report (Phase A2/A5/M of
 * docs/audits/ARGUS_PROJECT_A_AI_COST_GOVERNOR_DESIGN_NOTE.md). Read-only: the current reviewed
 * policy config, the per-(agent, provider) real-outcome quality ledger (§C), and recent
 * shadow-mode decisions (§J, from observability_events - no new table). Never gates a trade, never
 * writes anything.
 */
import { db } from '../db';
import { observabilityEvents } from '../db/schema';
import { desc, eq } from 'drizzle-orm';
import { aiCostGovernor } from '../config/aiCostGovernor';
import { getProviderSegmentedStats, type ProviderBucketStats } from '../services/ProviderPerformanceTracker';

export interface AiCostGovernorReport {
  enabled: boolean;
  liveEnabled: boolean;
  policies: typeof aiCostGovernor.policies;
  providerCostTiers: typeof aiCostGovernor.providerCostTiers;
  ledger: Record<string, ProviderBucketStats[]>;
  recentShadowDecisions: Array<{
    ts: string;
    traceId: string | null;
    agentType: string | null;
    policyTiers: string[] | null;
    chosenTier: string | null;
    changed: boolean | null;
    liveEnabled: boolean | null;
  }>;
}

export async function buildAiCostGovernorReport(limit = 50): Promise<AiCostGovernorReport> {
  const { isAiCostGovernorEnabled, isAiCostGovernorShadowOnly } = await import('../config/aiCostGovernor');

  const ledger: Record<string, ProviderBucketStats[]> = {};
  for (const agentType of Object.keys(aiCostGovernor.policies)) {
    ledger[agentType] = await getProviderSegmentedStats(agentType);
  }

  const rows = await db.select().from(observabilityEvents)
    .where(eq(observabilityEvents.eventType, 'AI_COST_GOVERNOR_SHADOW_COMPARISON'))
    .orderBy(desc(observabilityEvents.ts))
    .limit(Math.min(200, Math.max(1, limit)));

  const recentShadowDecisions = rows.map((r) => {
    let payload: any = null;
    try { payload = r.payload ? JSON.parse(r.payload) : null; } catch { payload = null; }
    return {
      ts: new Date(r.ts).toISOString(),
      traceId: r.traceId,
      agentType: payload?.agentType ?? null,
      policyTiers: payload?.policyTiers ?? null,
      chosenTier: payload?.chosenTier ?? null,
      changed: payload?.changed ?? null,
      liveEnabled: payload?.liveEnabled ?? null,
    };
  });

  return {
    enabled: isAiCostGovernorEnabled(),
    liveEnabled: !isAiCostGovernorShadowOnly(),
    policies: aiCostGovernor.policies,
    providerCostTiers: aiCostGovernor.providerCostTiers,
    ledger,
    recentShadowDecisions,
  };
}

export function formatAiCostGovernorReport(r: AiCostGovernorReport): string {
  const lines = [
    'AI COST GOVERNOR (Project A)',
    '-----------------------------',
    `Master flag enabled: ${r.enabled}`,
    `Live-routing enabled: ${r.liveEnabled} ${r.enabled && !r.liveEnabled ? '(shadow-only - real routing unaffected)' : ''}`,
    '',
    'POLICIES',
    '--------',
  ];
  for (const [agentType, policy] of Object.entries(r.policies)) {
    lines.push(`${agentType}: tiers=[${policy.tiers.join(',')}] qualityFloor=${policy.qualityFloor}`);
  }
  lines.push('', 'PROVIDER QUALITY LEDGER (real graded outcomes only)', '----------------------------------------------------');
  for (const [agentType, stats] of Object.entries(r.ledger)) {
    if (stats.length === 0) {
      lines.push(`${agentType}: (no graded outcomes yet)`);
      continue;
    }
    for (const s of stats) {
      lines.push(`${agentType} / ${s.provider}: total=${s.total} wins=${s.wins} losses=${s.losses} winRate=${(s.winRate * 100).toFixed(1)}% wilsonLower=${s.wilsonLower !== null ? s.wilsonLower.toFixed(3) : 'n/a'}`);
    }
  }
  lines.push('', `RECENT SHADOW DECISIONS (last ${r.recentShadowDecisions.length})`, '----------------------------------------');
  if (r.recentShadowDecisions.length === 0) {
    lines.push('(none recorded - governor master flag has likely never been enabled)');
  }
  for (const d of r.recentShadowDecisions) {
    lines.push(`${d.ts} ${d.agentType ?? '?'} tier=${d.chosenTier ?? '?'} changed=${d.changed} liveEnabled=${d.liveEnabled}`);
  }
  return lines.join('\n');
}
