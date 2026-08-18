/**
 * Safety-critical operator controls for TRADING_PAUSED / EMERGENCY_STOP.
 * Backend remains authority: ack = POST /api/v1/system/reconciliation/acknowledge
 * (pre-existing FILLED orphans only); resume = POST /api/v1/system/resume then
 * GET /api/v1/system/trading-state. Never writes trading_state locally.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACK_OPERATOR_REASON,
  RESUME_OPERATOR_REASON,
  acknowledgePreExistingFills,
  fetchReconOperatorStatus,
  haltBannerTitle,
  isHaltedTradingState,
  mapSafetyActionError,
  resumeAndConfirm,
  type OperatorActionPhase,
  type ReconOperatorStatus,
} from '../lib/tradingSafetyActions';

export type TradingPauseOperatorControlsProps = {
  /** Called only after GET /trading-state reports TRADING_ENABLED. */
  onAuthoritativeTradingState?: (tradingState: string, reason?: string) => void;
  compact?: boolean;
};

export default function TradingPauseOperatorControls({
  onAuthoritativeTradingState,
  compact,
}: TradingPauseOperatorControlsProps) {
  const [status, setStatus] = useState<ReconOperatorStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ackPhase, setAckPhase] = useState<OperatorActionPhase>('idle');
  const [resumePhase, setResumePhase] = useState<OperatorActionPhase>('idle');
  const [ackMessage, setAckMessage] = useState<string | null>(null);
  const [resumeMessage, setResumeMessage] = useState<string | null>(null);

  const onStateRef = useRef(onAuthoritativeTradingState);
  onStateRef.current = onAuthoritativeTradingState;

  const refresh = useCallback(async () => {
    const res = await fetchReconOperatorStatus();
    if (res.unauthorized) {
      setLoadError('Authentication required. Please sign in again.');
      return null;
    }
    if (!res.ok) {
      setLoadError(mapSafetyActionError(res, 'Unable to contact Argus backend. Trading state was not changed.'));
      return null;
    }
    setLoadError(null);
    setStatus(res.data);
    if (res.data.tradingState) {
      onStateRef.current?.(res.data.tradingState);
    }
    return res.data;
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!status && !loadError) {
    return <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Loading reconciliation evidence…</p>;
  }

  const halted = isHaltedTradingState(status?.tradingState);
  const orphans = status?.unackedFilledOrphans ?? [];
  const canAck = halted && ackPhase !== 'submitting' && resumePhase !== 'submitting' && orphans.length > 0;
  const canResume = halted && resumePhase !== 'submitting' && ackPhase !== 'submitting';

  const onAcknowledge = async () => {
    if (!canAck || !status) return;
    setAckPhase('submitting');
    setAckMessage(null);
    const res = await acknowledgePreExistingFills({
      broker: status.broker.name,
      reason: ACK_OPERATOR_REASON,
      orders: orphans,
    });
    if (!res.ok) {
      setAckPhase('error');
      setAckMessage(mapSafetyActionError(res, 'Unable to contact Argus backend. Trading state was not changed.'));
      return;
    }
    setAckPhase('success');
    setAckMessage(
      res.data?.ok === false
        ? String(res.data.error || 'Acknowledge did not persist.')
        : `Acknowledged (${res.data?.acknowledged ?? 0} new, ${res.data?.skipped ?? 0} already active). Does not resume trading.`,
    );
    await refresh();
  };

  const onResume = async () => {
    if (!canResume) return;
    setResumePhase('submitting');
    setResumeMessage(null);
    const result = await resumeAndConfirm(RESUME_OPERATOR_REASON);
    if (!result.ok) {
      setResumePhase('error');
      setResumeMessage(result.error || 'Resume failed.');
      if (result.tradingState) onStateRef.current?.(result.tradingState);
      await refresh();
      return;
    }
    setResumePhase('success');
    setResumeMessage('Trading Enabled. Awaiting real TRADE_IDEA_GENERATED — pipeline execution is not certified by this resume.');
    onStateRef.current?.(result.tradingState || 'TRADING_ENABLED', RESUME_OPERATOR_REASON);
    await refresh();
  };

  const latestLabel = status?.latest?.id == null
    ? 'No reconciliation_events row yet'
    : status.latest.matches
      ? `MATCH at ${status.latest.checkedAt} (${status.latest.broker || 'broker'})`
      : `MISMATCH (${status.latest.mismatchCount}) at ${status.latest.checkedAt}`;

  return (
    <div className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3'}>
      <div className="text-[10px] font-mono text-white/90 uppercase tracking-wider">
        {haltBannerTitle(status?.tradingState)} · {status?.tradingState || 'UNKNOWN'}
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-mono text-rose-100/90">
        <dt className="text-rose-200/70">Latest recon</dt>
        <dd>{latestLabel}</dd>
        <dt className="text-rose-200/70">Broker sync</dt>
        <dd>{status?.broker.syncState || 'unknown'}{status?.broker.readyForReconciliation ? ' · READY' : ''}</dd>
        <dt className="text-rose-200/70">Acknowledgements</dt>
        <dd>{status?.acknowledgements.count ?? 0} PRE_EXISTING_RECONCILED</dd>
        <dt className="text-rose-200/70">Unacked filled orphans</dt>
        <dd>{orphans.length === 0 ? 'none' : orphans.map((o) => `${o.symbol}:${o.brokerOrderId}`).join(', ')}</dd>
      </dl>
      {loadError && <p className="text-[10px] font-mono bg-black/30 px-2 py-1 rounded">{loadError}</p>}
      {ackMessage && <p className="text-[10px] font-mono bg-black/30 px-2 py-1 rounded">{ackMessage}</p>}
      {resumeMessage && <p className="text-[10px] font-mono bg-black/30 px-2 py-1 rounded">{resumeMessage}</p>}
      {halted && (
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={() => { void onAcknowledge(); }}
            disabled={!canAck}
            title={orphans.length === 0
              ? 'The existing acknowledgement API persists pre-existing FILLED broker orders missing locally. None are outstanding. Latest MATCH does not invent a mismatch to ack.'
              : ACK_OPERATOR_REASON}
            className="bg-slate-900/60 hover:bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded text-[10px] font-bold tracking-wider uppercase border border-white/20"
          >
            {ackPhase === 'submitting' ? 'Submitting...' : ackPhase === 'success' ? 'Acknowledged' : 'Acknowledge Reconciliation'}
          </button>
          <button
            type="button"
            onClick={() => { void onResume(); }}
            disabled={!canResume}
            className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded text-[10px] font-bold tracking-wider uppercase border border-emerald-300/60"
          >
            {resumePhase === 'submitting' ? 'Resuming...' : resumePhase === 'success' ? 'Trading Enabled' : 'Resume Autonomous Trading'}
          </button>
        </div>
      )}
    </div>
  );
}
