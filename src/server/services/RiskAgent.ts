/**
 * ==========================================================
 * Module:
 * RiskAgent.ts
 *
 * Purpose:
 * Core implementation and logic for the RiskAgent.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for RiskAgent
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import { riskEngine } from '../engines/RiskEngine';
import { marketDataWorker } from './MarketDataWorker';

export class RiskValidationAgent {
  private sessionOpen = true;

  constructor() {
    eventBus.on('CHIEF_APPROVED_IDEA', (approval) => this.assessRisk(approval));
  }

  assessRisk(approval: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agentsContext: string, currentPrice?: number, newsDetails?: any }) {
     console.log(`[RiskManager] Validating ${approval.side} on ${approval.symbol}`);

     if (!this.sessionOpen) {
        eventBus.emitRiskAssessment({
           traceId: approval.traceId,
           symbol: approval.symbol,
           side: approval.side,
           approved: false,
           maxQuantity: 0,
           reasoning: "Market session is currently closed."
        });
        return;
     }

     // Prefer the price the approving idea was actually generated against; fall back to the
     // latest live tick. We never invent a price (e.g. a hardcoded $150) - RiskEngine will
     // veto if none is available, since sizing against a fabricated price is worse than
     // refusing to trade.
     const estPrice = (approval.currentPrice && approval.currentPrice > 0)
        ? approval.currentPrice
        : marketDataWorker.getLatestPrice(approval.symbol) || undefined;

     const request: any = {
        traceId: approval.traceId,
        symbol: approval.symbol,
        side: approval.side as 'BUY' | 'SELL',
        currentPrice: estPrice,
        confidence: approval.confidence,
        newsDetails: approval.newsDetails
     };

     riskEngine.evaluateRisk(request);
  }
}

export const riskAgent = new RiskValidationAgent();
