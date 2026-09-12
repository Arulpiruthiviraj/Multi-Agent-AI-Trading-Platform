/**
 * 2026-09-11 - real strategy metadata catalog (id -> tier/family/live-eligibility/ownership/
 * lifecycle), composed entirely from already-existing, already-loaded sources - no new registry
 * class, no new state, no recomputed statistics. Fills a real gap found while auditing the
 * "Institutional Platform Transformation" mandate's StrategyRegistry ask: no single file in this
 * repo lists every strategy id this codebase actually knows about (CORE + EXPERIMENTAL TS +
 * JAVA_RESEARCH) alongside its family, whether it's live right now, and its lifecycle status.
 * Same composing convention as strategyScorecard.ts/strategyReadiness.ts - reads other modules'
 * real output, never re-derives it.
 *
 * Deliberately excludes win-rate/N/return numbers - buildAgentEdgeReport()/strategyReadiness.ts/
 * strategyScorecard.ts already own that (evidence-backed, per-strategy-observation) lens. This
 * file answers a narrower, purely-structural question: "what strategies exist, and is each one
 * currently reachable/live." Never imports ChiefTraderAgent/RiskEngine/OMS/BrokerManager.
 */
import { CORE_STRATEGIES, EXPERIMENTAL_STRATEGIES, isExperimentalStrategyLive } from '../quant/strategies/StrategyEngine';
import { experimentalStrategyRow } from '../config/quantExperimentalStrategies';
import { familyForStrategyId, JAVA_RESEARCH_STRATEGY_IDS, type QuantFamilyId } from '../quant/strategyFamilies';
import { getModelEntry, type ModelRegistryEntry } from '../config/modelRegistry';
import { getStrategyLifecycleStatus, type StrategyLifecycleStatus } from '../quant/strategies/StrategyEmissionEligibility';
import { isQuantJavaCoreEnabled } from '../config/tradingSafety';
import { tradingSafety } from '../config/tradingSafety';

export type StrategyCatalogTier = 'CORE' | 'EXPERIMENTAL' | 'JAVA_RESEARCH';

export interface StrategyCatalogRow {
  strategyId: string;
  tier: StrategyCatalogTier;
  family: QuantFamilyId | null;
  /** True only when this strategy can produce a real emitted idea (CORE) or contribute a vote
   *  (EXPERIMENTAL when its own env flag is on; JAVA_RESEARCH when the Java bridge is enabled)
   *  right now, in this process, with today's config - never a static claim. */
  liveEligible: boolean;
  /** The env var gating liveEligible for EXPERIMENTAL/JAVA_RESEARCH; null for CORE (always on). */
  enabledEnvVar: string | null;
  /** config/engineOwnership.json's strategies section - Node/Java ownership metadata. Only
   *  populated today for the 5 CORE ids (the only ones that file's strategies block covers);
   *  null for everything else - never fabricated. */
  ownership: ModelRegistryEntry | null;
  lifecycleStatus: StrategyLifecycleStatus;
}

function ownershipKey(strategyId: string): string {
  return strategyId.toLowerCase();
}

export async function buildStrategyCatalog(): Promise<StrategyCatalogRow[]> {
  const rows: StrategyCatalogRow[] = [];

  for (const def of CORE_STRATEGIES) {
    rows.push({
      strategyId: def.id,
      tier: 'CORE',
      family: familyForStrategyId(def.id),
      liveEligible: true,
      enabledEnvVar: null,
      ownership: getModelEntry('strategies', ownershipKey(def.id)),
      lifecycleStatus: await getStrategyLifecycleStatus(def.id),
    });
  }

  for (const def of EXPERIMENTAL_STRATEGIES) {
    rows.push({
      strategyId: def.id,
      tier: 'EXPERIMENTAL',
      family: familyForStrategyId(def.id),
      liveEligible: isExperimentalStrategyLive(def.id),
      enabledEnvVar: experimentalStrategyRow(def.id)?.enabledEnvVar ?? null,
      ownership: getModelEntry('strategies', ownershipKey(def.id)),
      lifecycleStatus: await getStrategyLifecycleStatus(def.id),
    });
  }

  const javaLive = isQuantJavaCoreEnabled();
  for (const strategyId of JAVA_RESEARCH_STRATEGY_IDS) {
    rows.push({
      strategyId,
      tier: 'JAVA_RESEARCH',
      family: familyForStrategyId(strategyId),
      liveEligible: javaLive,
      enabledEnvVar: tradingSafety.quantJavaCoreEnabledEnvVar,
      ownership: getModelEntry('strategies', ownershipKey(strategyId)),
      lifecycleStatus: await getStrategyLifecycleStatus(strategyId),
    });
  }

  return rows;
}

export function formatStrategyCatalog(rows: StrategyCatalogRow[]): string {
  const strategyWidth = Math.max(24, ...rows.map((r) => r.strategyId.length + 2));
  const lines = [
    'STRATEGY CATALOG', '----------------',
    'Strategy'.padEnd(strategyWidth) + 'Tier'.padEnd(16) + 'Family'.padEnd(24) + 'Live'.padEnd(6) + 'EnvVar'.padEnd(38) + 'Lifecycle',
  ];
  for (const r of rows) {
    lines.push(
      r.strategyId.padEnd(strategyWidth)
      + r.tier.padEnd(16)
      + (r.family ?? '(none)').padEnd(24)
      + (r.liveEligible ? 'YES' : 'no').padEnd(6)
      + (r.enabledEnvVar ?? '(always on)').padEnd(38)
      + r.lifecycleStatus,
    );
  }
  return lines.join('\n');
}
