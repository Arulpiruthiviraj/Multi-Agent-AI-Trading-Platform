/**
 * Operator kill-switch / reconciliation acknowledgements — existing backend contracts only.
 * Resume: POST /api/v1/system/resume
 * Ack:    POST /api/v1/system/reconciliation/acknowledge
 * Auth:   apiFetch credentials: 'include' (same session cookie as emergency-stop).
 * Never writes trading_state from the client.
 */
import { apiFetch, type ApiFetchResult } from './clientFetch';

export const TRADING_RESUME_PATH = '/api/v1/system/resume';
export const TRADING_STATE_PATH = '/api/v1/system/trading-state';
export const RECON_ACKNOWLEDGE_PATH = '/api/v1/system/reconciliation/acknowledge';
export const RECON_STATUS_PATH = '/api/v1/system/reconciliation/status';

export const ACK_OPERATOR_REASON =
  'Operator reviewed the current Alpaca paper portfolio and confirmed the reconciliation baseline is acceptable.';

export const RESUME_OPERATOR_REASON =
  'Operator reviewed current reconciliation evidence and resumed via POST /api/v1/system/resume.';

export type OperatorActionPhase = 'idle' | 'submitting' | 'success' | 'error';

export type UnackedFilledOrphan = {
  brokerOrderId: string;
  symbol: string;
  side?: string;
  quantity?: number;
  averageFillPrice?: number;
};

export type ReconOperatorStatus = {
  tradingState: string;
  emergencyStopActive: boolean;
  broker: { name: string; syncState: string; readyForReconciliation: boolean };
  latest: {
    id: number | null;
    checkedAt: string | null;
    broker: string | null;
    matches: boolean;
    mismatchCount: number;
    actionTaken: string | null;
  };
  acknowledgements: { count: number; note: string };
  unackedFilledOrphans: UnackedFilledOrphan[];
  note: string;
};

export function mapSafetyActionError(res: ApiFetchResult<unknown>, networkFallback: string): string {
  if (res.unauthorized) return 'Authentication required. Please sign in again.';
  if (res.status === 0) return networkFallback;
  return String(res.error || networkFallback);
}

export function resumeConfirmed(authoritativeTradingState: string | undefined | null): boolean {
  return authoritativeTradingState === 'TRADING_ENABLED';
}

export function isHaltedTradingState(tradingState: string | undefined | null): boolean {
  return tradingState === 'TRADING_PAUSED' || tradingState === 'EMERGENCY_STOP';
}

export function haltBannerTitle(tradingState: string | undefined | null): string {
  if (tradingState === 'TRADING_PAUSED') return 'TRADING PAUSED';
  if (tradingState === 'EMERGENCY_STOP') return 'EMERGENCY STOP ACTIVE';
  return 'TRADING HALTED';
}

export async function fetchReconOperatorStatus(): Promise<ApiFetchResult<ReconOperatorStatus>> {
  return apiFetch<ReconOperatorStatus>(RECON_STATUS_PATH);
}

export async function fetchAuthoritativeTradingState(): Promise<ApiFetchResult<{ tradingState: string; emergencyStopActive: boolean }>> {
  return apiFetch(TRADING_STATE_PATH);
}

export async function acknowledgePreExistingFills(opts: {
  broker?: string;
  reason: string;
  orders: UnackedFilledOrphan[];
}): Promise<ApiFetchResult<{ ok?: boolean; error?: string; acknowledged?: number; skipped?: number }>> {
  return apiFetch(RECON_ACKNOWLEDGE_PATH, {
    method: 'POST',
    body: JSON.stringify({
      broker: opts.broker,
      reason: opts.reason,
      orders: opts.orders.map((o) => ({
        brokerOrderId: o.brokerOrderId,
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity,
        averageFillPrice: o.averageFillPrice,
      })),
    }),
  });
}

export async function requestTradingResume(reason: string): Promise<ApiFetchResult<{ status?: string; tradingState?: string; error?: string }>> {
  return apiFetch(TRADING_RESUME_PATH, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/** HTTP ok is not enough — banner may drop only after backend reports TRADING_ENABLED. */
export async function resumeAndConfirm(reason: string): Promise<{
  ok: boolean;
  tradingState: string | null;
  error?: string;
}> {
  const posted = await requestTradingResume(reason);
  if (posted.unauthorized) {
    return { ok: false, tradingState: null, error: mapSafetyActionError(posted, 'Unable to contact Argus backend. Trading state was not changed.') };
  }
  if (!posted.ok) {
    return {
      ok: false,
      tradingState: typeof posted.data?.tradingState === 'string' ? posted.data.tradingState : null,
      error: mapSafetyActionError(posted, 'Unable to contact Argus backend. Trading state was not changed.'),
    };
  }
  const authoritative = await fetchAuthoritativeTradingState();
  if (!authoritative.ok) {
    return {
      ok: false,
      tradingState: typeof posted.data?.tradingState === 'string' ? posted.data.tradingState : null,
      error: mapSafetyActionError(authoritative, 'Unable to contact Argus backend. Trading state was not changed.'),
    };
  }
  const tradingState = String(authoritative.data?.tradingState || '');
  if (!resumeConfirmed(tradingState)) {
    return {
      ok: false,
      tradingState,
      error: `Resume request returned but backend tradingState is ${tradingState || 'unknown'}, not TRADING_ENABLED.`,
    };
  }
  return { ok: true, tradingState };
}
