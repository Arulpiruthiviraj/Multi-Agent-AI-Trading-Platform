/**
 * ==========================================================
 * Module:
 * RiskAgent.ts
 *
 * Purpose:
 * Thin forwarder from ChiefTraderAgent's approval to RiskEngine.evaluateRisk().
 *
 * Phase 2/5 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md): this used to run its own
 * emergency-stop/session-open/price-validity pre-checks BEFORE ever calling RiskEngine, each
 * short-circuiting with its own emitRiskAssessment - which meant a rejection at one of these
 * checks bypassed RiskEngine's gate-recording entirely (no risk_assessments/risk_gate_results
 * row was ever written), contradicting Phase 2's "every gate is evaluated and recorded"
 * guarantee. `emergencyStopActive` is now RiskEngine's own first gate; `sessionOpen` was dead
 * code (declared, checked, never set anywhere in the codebase - confirmed by repo-wide grep,
 * always true); the price-validity check was already redundant with RiskEngine's own
 * `price_validity` gate. This agent now always forwards to RiskEngine, whatever the price is.
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import { riskEngine } from '../engines/RiskEngine';
import { isTelemetryPulsePayload } from '../core/telemetryPulse';

export class RiskValidationAgent {
  constructor() {
    eventBus.on('CHIEF_APPROVED_IDEA', (approval) => {
      // Digital Twin telemetry pulse — UI animation only; never enter RiskEngine/OMS.
      if (isTelemetryPulsePayload(approval)) return;
      this.assessRisk(approval);
    });
  }

  assessRisk(approval: { traceId: string, transactionId?: string, symbol: string, side: string, confidence: number, reasoning: string, agentsContext: string, currentPrice?: number, newsDetails?: any, supportingQuantDetail?: any }) {
     console.log(`[RiskManager] Validating ${approval.side} on ${approval.symbol}`);

     const request: any = {
        traceId: approval.traceId,
        transactionId: approval.transactionId,
        symbol: approval.symbol,
        side: approval.side as 'BUY' | 'SELL',
        currentPrice: approval.currentPrice,
        confidence: approval.confidence,
        newsDetails: approval.newsDetails,
        // Phase 16B (ARGUS_PHASE16_READINESS_REPORT.md) - forwarded so RiskEngine can pass the
        // real per-strategy stop/target on to OrderManagement, which persists it onto the trade
        // row so PortfolioMonitor can honor that strategy's own exit logic instead of the
        // generic settings-driven thresholds. Null/undefined for any non-QuantEngine-sourced
        // idea, exactly like today.
        selectedQuantStrategy: approval.supportingQuantDetail?.selectedStrategy ?? null,
        quantStopPrice: approval.supportingQuantDetail?.proposedStop ?? null,
        quantTargetPrice: approval.supportingQuantDetail?.proposedTarget ?? null,
        quantInvalidationJson: approval.supportingQuantDetail ? JSON.stringify({
          texts: approval.supportingQuantDetail.invalidationConditions ?? [],
          strategy: approval.supportingQuantDetail.selectedStrategy ?? null,
          side: approval.side,
          entryRegime: approval.supportingQuantDetail.entryRegime ?? approval.supportingQuantDetail.regime?.regime ?? null,
          applicableRegimes: approval.supportingQuantDetail.applicableRegimes ?? [],
          structuralLevel: approval.supportingQuantDetail.structuralLevel ?? null,
        }) : null,
     };

     riskEngine.evaluateRisk(request);
  }
}

export const riskAgent = new RiskValidationAgent();
