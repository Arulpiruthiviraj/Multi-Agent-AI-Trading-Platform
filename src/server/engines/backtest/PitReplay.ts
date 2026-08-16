/**
 * Point-in-time decision snapshots for research replay.
 * Does not call live RiskEngine/OMS. LLM debate is NOT replayed (would require stored prompts).
 */
import { Evidence, EvidenceAggregator } from '../../services/EvidenceAggregator';
import { tradingSafety } from '../../config/tradingSafety';
import { agentWeightConfig, defaultAgentWeights } from '../../config/agentWeights';
import { reconstructPitDebate, type PitAiCallRow, type PitNewsClusterRow } from './PitLlmReplay';

export interface PitBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PitSnapshot {
  asOfMs: number;
  symbol: string;
  bar: PitBar;
  newsFinbertScore: number | null;
  quantIndicators: Record<string, unknown>;
  evidence: Evidence[];
}

export interface PitLedgerIdea {
  kind: string;
  agent: string | null;
  side: string | null;
  confidence: number | null;
  publishedAtMs: number;
  payloadJson?: string | null;
}

const snapshots: PitSnapshot[] = [];

export function recordPitSnapshot(snapshot: PitSnapshot): void {
  snapshots.push(snapshot);
}

export function listPitSnapshots(): readonly PitSnapshot[] {
  return snapshots;
}

export function clearPitSnapshots(): void {
  snapshots.length = 0;
}

export interface PitConsensusReplay {
  debateReplayed: boolean;
  side: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  independentAgreeingAgents: number;
  approved: boolean;
  reason: string;
}

export interface PitAiBuyGate {
  ledgerPresent: boolean;
  allowBuy: boolean;
  replay: PitConsensusReplay | null;
}

function weightForAgent(agentName: string): number {
  const listed = defaultAgentWeights[agentName];
  if (typeof listed === 'number' && Number.isFinite(listed)) return listed;
  return agentWeightConfig.unlistedAgentWeight;
}

export function evidenceFromPitIdeas(ideas: PitLedgerIdea[], symbol: string, currentPrice: number): Evidence[] {
  const out: Evidence[] = [];
  for (const row of ideas) {
    if (row.kind === 'CHIEF_TRADER' || row.kind === 'NEWS') continue;
    if (row.side !== 'BUY' && row.side !== 'SELL' && row.side !== 'HOLD') continue;
    if (typeof row.confidence !== 'number' || !Number.isFinite(row.confidence)) continue;
    const agent = row.agent && row.agent.length > 0 ? row.agent : 'UnknownAgent';
    out.push({
      traceId: `pit-${row.publishedAtMs}-${agent}`,
      symbol,
      side: row.side,
      confidence: row.confidence,
      agent,
      reasoning: row.payloadJson ?? `PIT ${row.kind}`,
      currentPrice,
      weight: weightForAgent(agent),
    });
  }
  return out;
}

/** Deterministic ChiefTrader vote math only (EvidenceAggregator + min agents + threshold). */
export function replayChiefTraderFromEvidence(evidence: Evidence[], debateReplayed = false): PitConsensusReplay {
  const agg = EvidenceAggregator.aggregate(evidence);
  const independent = new Set(agg.agreements.map(e => e.agent)).size;
  const minAgents = tradingSafety.minIndependentAgreeingAgents;
  const bar = tradingSafety.consensusApprovalThreshold;
  const agentsOk = independent >= minAgents;
  const confOk = agg.confidence >= bar;
  const approved = agg.side !== 'HOLD' && agentsOk && confOk;
  return {
    debateReplayed,
    side: agg.side,
    confidence: agg.confidence,
    independentAgreeingAgents: independent,
    approved,
    reason: approved
      ? `PIT consensus ${agg.side} conf=${agg.confidence.toFixed(3)} agents=${independent}${debateReplayed ? '; debate reconstructed' : '; debate not replayed'}`
      : `NO_TRADE: agents ${independent}/${minAgents}, conf ${agg.confidence.toFixed(3)} vs ${bar}${debateReplayed ? '' : ', debate not replayed'}`,
  };
}

export function replayChiefTraderFromPit(snapshot: PitSnapshot): PitConsensusReplay {
  return replayChiefTraderFromEvidence(snapshot.evidence);
}

/**
 * When the PIT ledger has agent/ChiefTrader rows at this bar, new BUYs must pass the same
 * ChiefTrader vote math as live (or a stored ChiefTrader decision). Empty ledger = technical
 * path only — LLM debate is never invented.
 */
export function evaluatePitAiBuyGate(
  rows: PitLedgerIdea[],
  symbol: string,
  currentPrice: number,
  options?: {
    allowTechnicalWhenEmpty?: boolean;
    asOfMs?: number;
    aiCalls?: PitAiCallRow[];
    newsClusters?: PitNewsClusterRow[];
  },
): PitAiBuyGate {
  const voterRows = rows.filter(r => r.kind === 'AGENT_REASONING' || r.kind === 'NEWS_AGENT');
  const chiefRows = rows.filter(r => r.kind === 'CHIEF_TRADER');
  const evidence = evidenceFromPitIdeas(voterRows, symbol, currentPrice);
  if (evidence.length === 0 && chiefRows.length === 0) {
    const technicalOnly = options?.allowTechnicalWhenEmpty === true;
    return {
      ledgerPresent: false,
      allowBuy: technicalOnly,
      replay: {
        debateReplayed: false,
        side: 'HOLD',
        confidence: 0,
        independentAgreeingAgents: 0,
        approved: false,
        reason: technicalOnly
          ? 'PIT ledger empty — technical strategy path only; not treated as AI-approved consensus.'
          : 'NO_TRADE: PIT ledger empty — technical BUY is not treated as AI-approved.',
      },
    };
  }
  const reconstruction = (options?.aiCalls && options?.newsClusters && typeof options.asOfMs === 'number')
    ? reconstructPitDebate({
      asOfMs: options.asOfMs,
      symbol,
      aiCalls: options.aiCalls,
      newsClusters: options.newsClusters,
    })
    : null;

  if (evidence.length > 0) {
    const replay = replayChiefTraderFromEvidence(evidence, reconstruction?.debateReplayed === true);
    if (reconstruction) {
      replay.reason = `${replay.reason} | ${reconstruction.reason}`;
    }
    return { ledgerPresent: true, allowBuy: replay.approved && replay.side === 'BUY', replay };
  }
  const latest = chiefRows.reduce((a, b) => (a.publishedAtMs >= b.publishedAtMs ? a : b));
  const side: 'BUY' | 'SELL' | 'HOLD' =
    latest.side === 'BUY' || latest.side === 'SELL' || latest.side === 'HOLD' ? latest.side : 'HOLD';
  const confidence = typeof latest.confidence === 'number' && Number.isFinite(latest.confidence) ? latest.confidence : 0;
  const approved = side === 'BUY' && confidence >= tradingSafety.consensusApprovalThreshold;
  const debateReplayed = reconstruction?.debateReplayed === true;
  const replay: PitConsensusReplay = {
    debateReplayed,
    side,
    confidence,
    independentAgreeingAgents: 0,
    approved,
    reason: debateReplayed
      ? reconstruction!.reason
      : approved
        ? `Stored PIT ChiefTrader BUY conf=${confidence.toFixed(3)}; debate not replayed`
        : `NO_TRADE: stored PIT ChiefTrader ${side} conf=${confidence.toFixed(3)}; debate not replayed`,
  };
  return { ledgerPresent: true, allowBuy: approved, replay };
}
