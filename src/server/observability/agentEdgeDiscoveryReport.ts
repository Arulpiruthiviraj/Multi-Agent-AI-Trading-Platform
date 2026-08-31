/**
 * Phase 10 (Agent Edge Discovery & Strategy Validation, 2026-08-31) - the single decision-ready
 * report this mission's Phase 9 requests: Agent Edge table, Strategy Edge (per QuantEngine
 * strategy id), Agent Combination Edge, and current Trading Eligibility. Pure composition of
 * already-tested research/ modules - no new statistics computed here.
 */
import { buildAgentEdgeReport, formatAgentEdgeReport, type AgentEdgeRow } from '../research/agentEdgeAnalytics';
import { buildAgentDependenceReport, formatAgentDependenceReport, type AgentPairDependence } from '../research/agentDependenceAnalysis';
import { buildAgentTradingEligibilityReport, formatAgentTradingEligibilityReport, type AgentBucketEligibility } from '../research/agentTradingEligibility';
import { buildWeightConsistencyReport, formatWeightConsistencyReport, type WeightConsistencyRow } from '../research/agentWeightConsistency';

export interface AgentEdgeDiscoveryReport {
  agentEdge: AgentEdgeRow[];
  agentDependence: AgentPairDependence[];
  eligibility: AgentBucketEligibility[];
  weightConsistency: WeightConsistencyRow[];
}

export async function buildAgentEdgeDiscoveryReport(): Promise<AgentEdgeDiscoveryReport> {
  const [agentEdge, agentDependence, eligibility, weightConsistency] = await Promise.all([
    buildAgentEdgeReport(),
    buildAgentDependenceReport(),
    buildAgentTradingEligibilityReport(),
    buildWeightConsistencyReport(),
  ]);
  return { agentEdge, agentDependence, eligibility, weightConsistency };
}

export function formatAgentEdgeDiscoveryReport(r: AgentEdgeDiscoveryReport): string {
  const eligibleCount = r.eligibility.filter((e) => e.status === 'ELIGIBLE').length;
  return [
    'ARGUS AGENT EDGE & STRATEGY VALIDATION',
    '========================================',
    `Eligible (agent, bucket) pairs: ${eligibleCount} / ${r.eligibility.length}`,
    '',
    formatAgentEdgeReport(r.agentEdge),
    '',
    formatAgentDependenceReport(r.agentDependence),
    '',
    formatWeightConsistencyReport(r.weightConsistency),
    '',
    formatAgentTradingEligibilityReport(r.eligibility),
  ].join('\n');
}
