export type SessionCheckpointVerdict = 'HEALTHY_ZERO_TRADE' | 'SUSPICIOUS_ZERO_TRADE' | 'INCONCLUSIVE_ZERO_TRADE' | 'PIPELINE_PROGRESS_NO_FILL' | 'TRADING';

/** Operator checkpoint slots (America/New_York) for early inactivity detection. */
export const SESSION_CHECKPOINT_SLOTS_ET = ['09:35', '10:00', '11:00', '13:00', '15:00'] as const;

export interface SessionCheckpointInput {
  /** e.g. TRADING_ENABLED | TRADING_PAUSED | UNKNOWN */
  tradingState: string;
  autobotEnabled: boolean;
  brokerDown: boolean;
  /** Market session label from tradingSessionReport (PRE_MARKET | RTH | AFTER_HOURS | CLOSED | UNKNOWN). */
  marketSession: string;
  marketDataReady: boolean;
  symbolsDiscovered: number;
  subscriptionsActive: number;
  subscriptionsFresh: number;
  /** QUANT_EVIDENCE_PRODUCED rows in window (quant assessments flowing). */
  quantAssessments: number;
  quantValidationFailed: number;
  /** Agent evaluations (strategy triggers) from the consensus pipeline. */
  strategyTriggers: number;
  quantIdeas: number;
  consensusRoundsStarted: number;
  consensusRejected: number;
  quantApprovals: number;
  riskEvaluations: number;
  riskApproved: number;
  ordersSubmitted: number;
  fills: number;
  topTerminalReasons: Array<{ code: string; count: number }>;
  aiAvailability: string;
  aiHealthyProviders: number;
  aiTotalProviders: number;
  quantAvailability: string;
  observabilityQueuePending: number;
  observabilityQueueDropped: number;
  /** Latest reconciliation cycle: true = match, false = mismatch, null = no cycles recorded. */
  reconciliationMatch: boolean | null;
  /** Absent means the diagnostic did not obtain policy evidence, never an invented zero. */
  quantPolicyEnabled?: boolean;
  authorizedPaperQuantStrategies?: number;
  quantPolicyEvaluations?: number;
}

export interface SessionCheckpointClassification {
  verdict: SessionCheckpointVerdict;
  upstreamActivity: number;
  terminalOutcomes: number;
  blockers: string[];
  reasons: string[];
}

export function classifySessionCheckpoint(input: SessionCheckpointInput): SessionCheckpointClassification {
  const upstreamActivity =
    input.symbolsDiscovered +
    input.subscriptionsActive +
    input.quantAssessments +
    input.strategyTriggers +
    input.quantIdeas +
    input.consensusRoundsStarted +
    input.riskEvaluations;
  const terminalOutcomes =
    input.quantApprovals + input.riskApproved + input.ordersSubmitted + input.fills;

  const blockers: string[] = [];
  if (input.tradingState === 'TRADING_PAUSED') blockers.push('TRADING_PAUSED');
  if (input.brokerDown) blockers.push('BROKER_DOWN');
  // Subscription starvation with zero promotions: no usable subscriptions at all.
  if (input.subscriptionsActive === 0 || !input.marketDataReady) blockers.push('SUBSCRIPTION_STARVATION');
  if (input.quantPolicyEnabled === true && input.authorizedPaperQuantStrategies === 0 &&
      input.quantPolicyEvaluations === 0 && input.quantAssessments > 0) {
    blockers.push('QUANT_PATH_UNREACHABLE');
  }
  if (input.reconciliationMatch === false) blockers.push('RECONCILIATION_MISMATCH');
  // NOTE: all-AI-down is deliberately NOT a blocker. Quant-first: AI is optional and a
  // healthy quant pipeline flows with AI down. Never flag AI-down as the cause.

  const reasons: string[] = [];
  if (blockers.includes('QUANT_PATH_UNREACHABLE')) {
    reasons.push('Quant policy is enabled and assessments are flowing, but no strategy has PAPER Quant authority and no Quant policy evaluation occurred. This is an authorization gap, not proof that AI caused the blockage.');
  }
  if (terminalOutcomes > 0) {
    reasons.push(
      `${terminalOutcomes} terminal outcome(s) this session ` +
        `(approvals ${input.quantApprovals}, risk approvals ${input.riskApproved}, ` +
        `orders ${input.ordersSubmitted}, fills ${input.fills}). Approvals and submissions alone do not prove execution.`,
    );
    return { verdict: input.fills > 0 ? 'TRADING' : 'PIPELINE_PROGRESS_NO_FILL', upstreamActivity, terminalOutcomes, blockers, reasons };
  }
  if (upstreamActivity > 0 && blockers.length > 0) {
    reasons.push(
      `Upstream activity is flowing (${upstreamActivity} discoveries/subscriptions/assessments/` +
        `ideas/rounds/evaluations) but produced ZERO terminal outcomes, and a fixable global ` +
        `blocker exists: ${blockers.join(', ')}.`,
    );
    if (input.topTerminalReasons.length > 0) {
      reasons.push(
        'Top terminal reasons: ' +
          input.topTerminalReasons.slice(0, 5).map((t) => `${t.code}×${t.count}`).join(', ') + '.',
      );
    }
    return { verdict: 'SUSPICIOUS_ZERO_TRADE', upstreamActivity, terminalOutcomes, blockers, reasons };
  }
  if (input.quantPolicyEnabled === true && (input.authorizedPaperQuantStrategies === undefined ||
      input.quantPolicyEvaluations === undefined)) {
    reasons.push('Quant policy reachability is UNKNOWN: required authority/activity evidence is unavailable. No healthy-zero-trade conclusion can be established.');
    return { verdict: 'INCONCLUSIVE_ZERO_TRADE', upstreamActivity, terminalOutcomes, blockers, reasons };
  }
  if (upstreamActivity === 0) {
    reasons.push(
      'No upstream pipeline activity yet this session ' +
        `(state ${input.tradingState}, market session ${input.marketSession}) — ` +
        'zero trades is the expected outcome, not a stall.',
    );
  } else {
    reasons.push(
      `Upstream activity is flowing (${upstreamActivity}) with zero terminal outcomes, but no ` +
        'fixable global blocker is present — the pipeline is rejecting on merit ' +
        '(see top terminal reasons), which is healthy quant-first behavior.',
    );
    if (input.topTerminalReasons.length > 0) {
      reasons.push(
        'Top terminal reasons: ' +
          input.topTerminalReasons.slice(0, 5).map((t) => `${t.code}×${t.count}`).join(', ') + '.',
      );
    }
  }
  if (input.aiAvailability === 'AI_UNAVAILABLE') {
    reasons.push(
      'AI is fully down — advisory only, not a blocker: quant-first means AI absence must ' +
        'never stall the quant pipeline.',
    );
  }
  return { verdict: 'HEALTHY_ZERO_TRADE', upstreamActivity, terminalOutcomes, blockers, reasons };
}

