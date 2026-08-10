/**
 * ==========================================================
 * Module: OpenAlice integration types
 *
 * Purpose:
 * Shared shapes for the OpenAlice verification adapter. OpenAlice is an external,
 * independent AI system reached only over MCP (Model Context Protocol) - Argus never
 * imports its code and never gives it credentials that can place a trade. See
 * OPENALICE_INTEGRATION_AUDIT.md for the full architecture rationale.
 *
 * Real OpenAlice mechanics that shape this file (confirmed by reading OpenAlice's own
 * source, not just its README):
 * - There is no synchronous "research and give me a verdict" tool. `issue_create` files a
 *   board item; unless its `when` field is set, no agent runtime ever picks it up.
 * - Once an agent finishes, it reports back by pushing to the caller's inbox. `inbox_read`
 *   returns entries whose `origin.issueId` correlates a report back to the issue that
 *   spawned it. This can take minutes, so verification is fire-and-forget + poll, never a
 *   blocking call in the decision path.
 * ==========================================================
 */

/** What Argus is asking OpenAlice to independently look into. */
export type VerificationMode =
  | 'BLIND_RESEARCH'      // OpenAlice is not told Argus's side/confidence - pure independent read
  | 'TRADE_VERIFICATION'  // OpenAlice is told the proposed trade and asked to agree/disagree
  | 'ADVERSARIAL_REVIEW'; // OpenAlice is explicitly asked to argue against the proposed trade

export interface VerificationRequest {
  requestId: string;       // Argus-side id, also used as the OpenAlice issue id for correlation
  traceId: string;         // Argus decision-lifecycle traceId (event_traces correlationId)
  symbol: string;
  side: 'BUY' | 'SELL';
  mode: VerificationMode;
  argusConfidence: number; // 0-1, omitted from the OpenAlice prompt when mode === 'BLIND_RESEARCH'
  argusReasoning: string;
  createdAt: string;       // ISO timestamp
}

export type VerificationDirection = 'AGREE' | 'DISAGREE' | 'NO_OPINION';

export interface VerificationResult {
  requestId: string;
  traceId: string;
  symbol: string;
  direction: VerificationDirection;
  confidence: number;      // 0-1, OpenAlice's own stated confidence in its direction
  thesis: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  raw: string;             // the untouched text OpenAlice pushed to the inbox, for audit
  receivedAt: string;      // ISO timestamp - when Argus actually saw the result, not when OpenAlice wrote it
  latencyMs: number;       // receivedAt - createdAt, real observed latency for the cost/latency assessment
}

export type VerificationStatus = 'PENDING' | 'COMPLETED' | 'TIMED_OUT' | 'FAILED';

export interface PendingVerification {
  request: VerificationRequest;
  status: VerificationStatus;
  result?: VerificationResult;
  error?: string;
  pollAttempts: number;
}

export interface VerificationHealth {
  reachable: boolean;
  detail: string;
  checkedAt: string;
}

/**
 * Contract any external verification provider must satisfy. OpenAlice is the only
 * implementation today, but this interface is what keeps Argus's own code (EscalationPolicy,
 * ChiefTraderAgent) from depending on OpenAlice-specific MCP tool names directly.
 */
export interface ExternalVerificationProvider {
  readonly name: string;
  healthCheck(): Promise<VerificationHealth>;
  /** Fire-and-forget: files the request and returns immediately. Never awaits a verdict. */
  requestVerification(request: VerificationRequest): Promise<void>;
}
