/**
 * Phase 9 (2026-08-31) - the single authoritative "trading-funnel" view requested for
 * argus-cli trading-funnel. Composes three already-real, already-tested sources rather than
 * introducing a new data path: candidateLifecycle's in-memory state counts, the
 * CONSENSUS_TERMINAL_REASON-derived consensusPipelineReport, and providerHealthMatrix. No new
 * counters are invented here - every number below already exists in one of those modules.
 */
import { listCandidates } from '../continuous/candidateLifecycle';
import { buildConsensusPipelineReport, ConsensusPipelineReport } from './consensusPipelineReport';
import { buildProviderHealthMatrix, ProviderHealthRow } from './providerHealthMatrix';

export interface TradingFunnelReport {
  windowSinceIso: string;
  candidatesByState: Record<string, number>;
  consensus: ConsensusPipelineReport;
  providers: ProviderHealthRow[];
}

export async function buildTradingFunnelReport(sinceIso: string): Promise<TradingFunnelReport> {
  const candidatesByState: Record<string, number> = {};
  for (const c of listCandidates()) {
    candidatesByState[c.state] = (candidatesByState[c.state] ?? 0) + 1;
  }
  const [consensus, providers] = await Promise.all([
    buildConsensusPipelineReport(sinceIso),
    buildProviderHealthMatrix(),
  ]);
  return { windowSinceIso: sinceIso, candidatesByState, consensus, providers };
}

export function formatTradingFunnelReport(r: TradingFunnelReport): string {
  const c = r.consensus;
  const lines = [
    'ARGUS TRADING FUNNEL',
    '====================',
    `Window since: ${r.windowSinceIso}`,
    '',
    'CANDIDATES (in-memory lifecycle, current)',
    '------------------------------------------',
    ...Object.entries(r.candidatesByState).map(([state, n]) => `${state.padEnd(16)}${n}`),
    (Object.keys(r.candidatesByState).length === 0 ? '(none tracked)' : ''),
    '',
    'AGENT EVALUATIONS / VOTES',
    '--------------------------',
    `Total evaluations:          ${c.evaluations}`,
    `Directional evaluations:    ${c.directionalEvaluations}`,
    `HOLD/DATA_UNAVAILABLE:      ${c.holdCount}`,
    ...Object.entries(c.directionalVotesByAgent).sort((a, b) => b[1] - a[1]).map(([agent, n]) => `  ${agent.padEnd(26)}${n}`),
    '',
    'SAME-CANDIDATE / INDEPENDENCE',
    '-------------------------------',
    `0-agent agreement:          ${c.independentAgreementCounts['0']}`,
    `1-agent agreement:          ${c.independentAgreementCounts['1']}`,
    `2-agent agreement:          ${c.independentAgreementCounts['2']}`,
    `3-agent agreement:          ${c.independentAgreementCounts['3']}`,
    `4+ agent agreement:         ${c.independentAgreementCounts['4+']}`,
    '',
    'CALIBRATION / CONSENSUS',
    '-------------------------',
    `Confidence >= 0.60:         ${c.confidenceAtLeast60}`,
    `Confidence >= 0.75:         ${c.confidenceAtLeast75}`,
    `Moderate approved:          ${c.moderateEligibleCount}`,
    `Strong approved:            ${c.strongApprovedCount}`,
    '',
    'RISK / OMS / FILLS',
    '--------------------',
    `RiskEngine reached:         ${c.riskEngineReached}`,
    `Risk approved:              ${c.riskApproved}`,
    `OMS orders:                 ${c.ordersPlaced}`,
    `Paper fills:                ${c.fillsRecorded}`,
    '',
    'TOP NO-TRADE REASONS',
    '----------------------',
    ...c.topTerminalReasons.map((t) => `${t.code.padEnd(32)}${t.count}`),
    '',
    'PROVIDER HEALTH',
    '-----------------',
    ...r.providers.map((p) => {
      const cooldown = p.routingCooldownRemainingMs ? ` (cooldown ${Math.ceil(p.routingCooldownRemainingMs / 1000)}s)` : '';
      return `${p.providerName.padEnd(16)}${p.routingState.padEnd(14)}dbHealth=${(p.dbHealth ?? 'unknown').padEnd(10)}recent=${p.recentSuccessCount}/${p.recentCallCount}${cooldown}`;
    }),
  ];
  return lines.filter((l) => l !== '').join('\n');
}
