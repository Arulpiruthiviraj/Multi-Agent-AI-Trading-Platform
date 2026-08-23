/**
 * Replay aiMode consensus handlers.
 * DISABLED → deterministic Quant + Technical votes only.
 * RECORDED_DECISION_REPLAY → PIT ledger votes when present; else same as DISABLED (no invented LLM).
 * LIVE_MODEL_REPLAY → optional live routeConsensus with hard timeout; fail-closed to DISABLED path.
 * Never lowers consensus floors (0.75 / min 2 independent agents).
 */
import {
  evidenceFromPitIdeas,
  evaluatePitAiBuyGate,
  replayChiefTraderFromEvidence,
  type PitLedgerIdea,
  type PitConsensusReplay,
} from './PitReplay';
import type { Evidence } from '../../services/EvidenceAggregator';
import { tradingSafety } from '../../config/tradingSafety';
import { replaySafety } from '../../replay/replaySafety';
import type { ReplayAiMode } from '../../replay/ReplayContext';

export interface ReplayAiModeResult {
  mode: ReplayAiMode;
  ideas: PitLedgerIdea[];
  evidence: Evidence[];
  consensus: PitConsensusReplay | null;
  ledgerUsed: boolean;
  liveModelInvoked: boolean;
  reason: string;
}

/**
 * Build the idea set / consensus path for the configured aiMode.
 * `baseIdeas` are Quant (+ Technical when independently firing) — always the DISABLED spine.
 */
export function resolveReplayAiModeConsensus(opts: {
  aiMode: ReplayAiMode;
  symbol: string;
  currentPrice: number;
  asOfMs: number;
  baseIdeas: PitLedgerIdea[];
  recordedIdeas?: PitLedgerIdea[];
}): ReplayAiModeResult {
  const mode = opts.aiMode;
  const baseEvidence = evidenceFromPitIdeas(opts.baseIdeas, opts.symbol, opts.currentPrice);

  if (mode === 'DISABLED') {
    const consensus = replayChiefTraderFromEvidence(baseEvidence, false);
    return {
      mode,
      ideas: opts.baseIdeas,
      evidence: baseEvidence,
      consensus,
      ledgerUsed: false,
      liveModelInvoked: false,
      reason: 'DISABLED: deterministic Quant+Technical vote math only',
    };
  }

  if (mode === 'RECORDED_DECISION_REPLAY') {
    const recorded = opts.recordedIdeas ?? [];
    const gate = evaluatePitAiBuyGate(recorded, opts.symbol, opts.currentPrice, {
      allowTechnicalWhenEmpty: true,
      asOfMs: opts.asOfMs,
    });
    if (gate.ledgerPresent && recorded.length > 0) {
      const evidence = evidenceFromPitIdeas(
        recorded.filter((r) => r.kind === 'AGENT_REASONING' || r.kind === 'NEWS_AGENT'),
        opts.symbol,
        opts.currentPrice,
      );
      return {
        mode,
        ideas: recorded,
        evidence: evidence.length > 0 ? evidence : baseEvidence,
        consensus: gate.replay,
        ledgerUsed: true,
        liveModelInvoked: false,
        reason: gate.replay?.reason ?? 'RECORDED_DECISION_REPLAY: PIT ledger votes',
      };
    }
    const consensus = replayChiefTraderFromEvidence(baseEvidence, false);
    return {
      mode,
      ideas: opts.baseIdeas,
      evidence: baseEvidence,
      consensus,
      ledgerUsed: false,
      liveModelInvoked: false,
      reason: 'RECORDED_DECISION_REPLAY: PIT ledger empty — fell back to DISABLED Quant+Technical path (no fabricated LLM votes)',
    };
  }

  // LIVE_MODEL_REPLAY — caller may attach a live ConsensusDebate vote asynchronously.
  // Sync path keeps DISABLED math; liveModelInvoked flips when a vote is merged later.
  const consensus = replayChiefTraderFromEvidence(baseEvidence, false);
  return {
    mode,
    ideas: opts.baseIdeas,
    evidence: baseEvidence,
    consensus,
    ledgerUsed: false,
    liveModelInvoked: false,
    reason: `${replaySafety.aiModeHonestyDescription} LIVE_MODEL_REPLAY uses current models only when explicitly invoked; default consensus math matches DISABLED until a live vote arrives. Floors remain ${tradingSafety.consensusApprovalThreshold}/${tradingSafety.minIndependentAgreeingAgents}.`,
  };
}

/** Merge an optional live ConsensusDebate evidence row (fail-closed if invalid). */
export function mergeLiveConsensusDebateVote(
  base: ReplayAiModeResult,
  debate: { side: 'BUY' | 'SELL' | 'HOLD'; confidence: number; reasoning?: string } | null,
  symbol: string,
  currentPrice: number,
): ReplayAiModeResult {
  if (!debate || !Number.isFinite(debate.confidence) || debate.confidence <= 0) {
    return {
      ...base,
      liveModelInvoked: true,
      reason: `${base.reason} | LIVE_MODEL_REPLAY: routeConsensus failed/empty → HOLD 0 (fail-closed)`,
    };
  }
  const idea: PitLedgerIdea = {
    kind: 'AGENT_REASONING',
    agent: 'ConsensusDebate',
    side: debate.side,
    confidence: Math.min(1, Math.max(0, debate.confidence)),
    publishedAtMs: Date.now(),
    payloadJson: debate.reasoning ?? 'LIVE_MODEL_REPLAY',
  };
  const ideas = [...base.ideas, idea];
  const evidence = evidenceFromPitIdeas(ideas, symbol, currentPrice);
  const consensus = replayChiefTraderFromEvidence(evidence, true);
  return {
    ...base,
    ideas,
    evidence,
    consensus,
    liveModelInvoked: true,
    reason: `${base.reason} | LIVE_MODEL_REPLAY: ConsensusDebate vote merged`,
  };
}
