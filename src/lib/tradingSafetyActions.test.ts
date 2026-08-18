import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ACK_OPERATOR_REASON,
  RECON_ACKNOWLEDGE_PATH,
  RECON_STATUS_PATH,
  TRADING_RESUME_PATH,
  TRADING_STATE_PATH,
  acknowledgePreExistingFills,
  haltBannerTitle,
  isHaltedTradingState,
  mapSafetyActionError,
  resumeAndConfirm,
  resumeConfirmed,
} from './tradingSafetyActions';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('tradingSafetyActions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resumeConfirmed is true only for TRADING_ENABLED', () => {
    expect(resumeConfirmed('TRADING_ENABLED')).toBe(true);
    expect(resumeConfirmed('TRADING_PAUSED')).toBe(false);
    expect(resumeConfirmed('EMERGENCY_STOP')).toBe(false);
    expect(resumeConfirmed(undefined)).toBe(false);
  });

  it('isHaltedTradingState covers pause and emergency-stop only', () => {
    expect(isHaltedTradingState('TRADING_PAUSED')).toBe(true);
    expect(isHaltedTradingState('EMERGENCY_STOP')).toBe(true);
    expect(isHaltedTradingState('TRADING_ENABLED')).toBe(false);
  });

  it('maps 401 and network failures to operator copy', () => {
    expect(mapSafetyActionError({ ok: false, status: 401, data: {}, unauthorized: true, error: 'x' }, 'net'))
      .toBe('Authentication required. Please sign in again.');
    expect(mapSafetyActionError({ ok: false, status: 0, data: {}, error: 'fetch failed' }, 'Unable to contact Argus backend. Trading state was not changed.'))
      .toBe('Unable to contact Argus backend. Trading state was not changed.');
    expect(mapSafetyActionError({ ok: false, status: 400, data: { error: 'At least one broker order is required.' }, error: 'At least one broker order is required.' }, 'net'))
      .toBe('At least one broker order is required.');
  });

  it('acknowledge POSTs the existing recon ack contract with session credentials', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, acknowledged: 1, skipped: 0 }));
    await acknowledgePreExistingFills({
      broker: 'Alpaca',
      reason: ACK_OPERATOR_REASON,
      orders: [{ brokerOrderId: 'ord-1', symbol: 'AAPL', quantity: 1 }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RECON_ACKNOWLEDGE_PATH);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    const body = JSON.parse(String(init?.body));
    expect(body.reason).toBe(ACK_OPERATOR_REASON);
    expect(body.orders[0].brokerOrderId).toBe('ord-1');
    expect(body.orders[0].symbol).toBe('AAPL');
  });

  it('resumeAndConfirm treats HTTP ok + lingering TRADING_PAUSED as failure', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ok', tradingState: 'TRADING_ENABLED' }))
      .mockResolvedValueOnce(jsonResponse(200, { tradingState: 'TRADING_PAUSED', emergencyStopActive: false }));
    const result = await resumeAndConfirm('operator review');
    expect(fetchMock.mock.calls[0][0]).toBe(TRADING_RESUME_PATH);
    expect(fetchMock.mock.calls[1][0]).toBe(TRADING_STATE_PATH);
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');
    expect(result.ok).toBe(false);
    expect(result.tradingState).toBe('TRADING_PAUSED');
    expect(result.error).toMatch(/not TRADING_ENABLED/);
  });

  it('resumeAndConfirm succeeds only after authoritative TRADING_ENABLED', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ok', tradingState: 'TRADING_ENABLED' }))
      .mockResolvedValueOnce(jsonResponse(200, { tradingState: 'TRADING_ENABLED', emergencyStopActive: false }));
    const result = await resumeAndConfirm('operator review');
    expect(result.ok).toBe(true);
    expect(result.tradingState).toBe('TRADING_ENABLED');
  });

  it('resumeAndConfirm surfaces unauthorized without claiming a state change', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));
    const result = await resumeAndConfirm('operator review');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Authentication required. Please sign in again.');
  });

  it('haltBannerTitle distinguishes pause from emergency-stop', () => {
    expect(haltBannerTitle('TRADING_PAUSED')).toBe('TRADING PAUSED');
    expect(haltBannerTitle('EMERGENCY_STOP')).toBe('EMERGENCY STOP ACTIVE');
  });
});

describe('operator-control source invariants', () => {
  const root = process.cwd();

  it('TradingPauseOperatorControls uses existing ack/resume paths and never writes trading_state', () => {
    const src = readFileSync(join(root, 'src/components/TradingPauseOperatorControls.tsx'), 'utf8');
    expect(src).toContain('acknowledgePreExistingFills');
    expect(src).toContain('resumeAndConfirm');
    expect(src).toContain('Acknowledge Reconciliation');
    expect(src).toContain('Resume Autonomous Trading');
    expect(src).not.toMatch(/trading_state\s*=/);
    expect(src).not.toMatch(/db\.(update|insert|delete)/);
    expect(src).not.toMatch(/setEnginesHalted\(false\)/);
    expect(src).not.toMatch(/TRADE_IDEA_GENERATED.*fabricat/i);
    expect(src).toContain('Awaiting real TRADE_IDEA_GENERATED');
  });

  it('App halt banner mounts operator controls instead of a local-only resume', () => {
    const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    expect(app).toContain('TradingPauseOperatorControls');
    expect(app).not.toMatch(/setEnginesHalted\(false\)/);
  });
});
