/**
 * ==========================================================
 * Module: TransactionLifecycleTracker
 *
 * Purpose:
 * Closes the real bug identified in FINAL_ANALYSIS.md (Section 15.1/15.22 Critical #2, this
 * engagement's own self-introduced gap from the Transaction Observatory Phase 0 work):
 * `transactions.status` was written exactly once at mint time (`TransactionRegistry.
 * recordConsensusTransaction`) and never updated afterward - live-confirmed via
 * `GET /api/v2/transactions?limit=200` returning zero rows in any terminal state (RISK_REJECTED/
 * EXECUTED/FILLED), even for trades that had already been rejected or filled for real.
 *
 * Listens for the real, already-emitted downstream lifecycle events and calls
 * `TransactionRegistry.updateTransactionStatus()` as each one actually happens - never fabricates
 * or guesses a transition ahead of the real event that causes it. Mirrors RiskAgent/
 * OrderManagementService's own pattern: a singleton whose constructor registers EventBus
 * listeners, referenced bare in SystemBootstrap.start() alongside them.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { isTelemetryPulsePayload } from '../core/telemetryPulse';
import { updateTransactionStatus } from '../core/TransactionRegistry';

export class TransactionLifecycleTracker {
  constructor() {
    // Fires for BOTH outcomes (RiskEngine's own catch block also calls emitRiskAssessment), so
    // this is a real, always-reached hook for a risk rejection - not just the happy path.
    eventBus.on('RISK_ASSESSMENT_COMPLETED', (assessment: any) => {
      if (isTelemetryPulsePayload(assessment)) return;
      if (!assessment.transactionId) return; // no transaction was minted for this proposal - nothing to update
      if (assessment.approved) return; // approval doesn't close the transaction - the order stages below do
      updateTransactionStatus(assessment.transactionId, 'RISK_REJECTED', { outcome: 'N_A', closed: true });
    });

    // The order has been handed to the broker - real, in-flight, not yet resolved either way.
    eventBus.on('ORDER_SUBMITTED', (order: any) => {
      if (!order.transactionId) return;
      updateTransactionStatus(order.transactionId, 'EXECUTED');
    });

    // The one event that fires for EVERY terminal order outcome - FILLED, REJECTED, CANCELED, or
    // still-PENDING after OrderManagementService's own poll timeout (in which case `status` here
    // is whatever the broker last reported, which may still be 'PENDING' - deliberately NOT
    // treated as terminal below, since fabricating a resolution the broker hasn't actually given
    // yet would be exactly the kind of dishonest state this fix exists to prevent).
    eventBus.on('ORDER_EXECUTED', (order: any) => {
      if (!order.transactionId) return;
      if (order.status === 'FILLED') {
        const outcome = typeof order.profitLoss === 'number'
          ? (order.profitLoss > 0 ? 'WIN' : order.profitLoss < 0 ? 'LOSS' : 'PENDING')
          : 'PENDING'; // a BUY fill opens a position with no realized P&L yet - genuinely still PENDING, not a fabricated WIN/LOSS
        updateTransactionStatus(order.transactionId, 'FILLED', { outcome, closed: true });
      } else if (order.status === 'REJECTED' || order.status === 'CANCELED') {
        updateTransactionStatus(order.transactionId, 'ORDER_REJECTED', { outcome: 'N_A', closed: true });
      }
      // else: still PENDING after the poll timeout - leave it at 'EXECUTED' (set above), not terminal.
    });
  }
}

export const transactionLifecycleTracker = new TransactionLifecycleTracker();
