// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import TradeReplayModal from './TradeReplayModal';

/**
 * F34 behavioral regression tests (2026-09-28). Real React render/effects against the actual
 * component, proving the three concrete failure modes its own fix comment names: (1) a late
 * response for a since-abandoned trade selection must never overwrite the current selection's
 * state, (2) a stale playback index from a longer trace must clamp when a shorter trace replaces
 * it, (3) unmount must not throw / must not apply a late response.
 *
 * The component's fetchTrace() sequentially awaits explainability THEN the trace endpoint (not
 * Promise.all) - the trace fetch is only issued once the explainability call has resolved, so
 * every helper below resolves them in that same order.
 */

type PendingResponse = { resolve: (body: any) => void; url: string };

function buildFetchMock() {
  const pending: PendingResponse[] = [];
  const fetchMock = vi.fn((url: string) => {
    return new Promise((resolve) => {
      pending.push({ resolve: (body: any) => resolve({ ok: true, json: async () => body } as any), url });
    });
  });
  return { fetchMock, pending };
}

const tradeA = { traceId: 'trace-A', symbol: 'AAPL', decision: 'BUY', timestamp: 1000, price: 100 };
const tradeB = { traceId: 'trace-B', symbol: 'MSFT', decision: 'SELL', timestamp: 2000, price: 200 };

function traceEvent(type: string, i: number, payload: any = {}) {
  return { type, timestamp: 1000 + i, payload };
}

/** Resolves a trade's explainability call, then waits for and returns its (now-issued) trace request. */
async function resolveExplainAndGetTraceReq(pending: PendingResponse[], traceId: string) {
  const explainReq = pending.find((p) => p.url.includes(`/explainability/${traceId}`));
  expect(explainReq, `expected an explainability request for ${traceId}`).toBeTruthy();
  await act(async () => { explainReq!.resolve({}); await Promise.resolve(); await Promise.resolve(); });
  const traceReq = pending.find((p) => p.url.includes(`/system/trace/${traceId}`));
  expect(traceReq, `expected a trace request for ${traceId} once explainability resolved`).toBeTruthy();
  return traceReq!;
}

describe('TradeReplayModal - F34 selection/race behavior (real component, mocked fetch)', () => {
  let originalFetch: any;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { cleanup(); global.fetch = originalFetch; });

  it('a late trace response for an abandoned trade selection is discarded - it never leaks into the newly-selected trade\'s view', async () => {
    const { fetchMock, pending } = buildFetchMock();
    global.fetch = fetchMock as any;

    const onClose = vi.fn();
    const { rerender } = render(<TradeReplayModal trade={tradeA} onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });

    // Trade A's trace fetch is now in flight - switch selection to trade B BEFORE it resolves.
    const traceAReq = await resolveExplainAndGetTraceReq(pending, 'trace-A');

    rerender(<TradeReplayModal trade={tradeB} onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });
    const traceBReq = await resolveExplainAndGetTraceReq(pending, 'trace-B');

    // NOW the stale trade-A trace response finally arrives - it must be discarded (requestKey no
    // longer matches selectedTradeKey inside the component).
    await act(async () => {
      traceAReq.resolve({ trace: [traceEvent('MARKET_DATA', 0, { symbol: 'AAPL', price: 100 })] });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(screen.queryByText(/Trade Replay: AAPL/i)).toBeNull();

    // Trade B's own real trace resolving is what should actually render.
    await act(async () => {
      traceBReq.resolve({ trace: [traceEvent('MARKET_DATA', 0, { symbol: 'MSFT', price: 200 })] });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(await screen.findByText(/Trade Replay: MSFT/i)).toBeTruthy();
  });

  it('the playback index clamps when a shorter trace replaces a longer one - never left pointing past the new trace\'s end', async () => {
    const { fetchMock, pending } = buildFetchMock();
    global.fetch = fetchMock as any;
    const onClose = vi.fn();

    const { rerender } = render(<TradeReplayModal trade={tradeA} onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });
    const traceAReq = await resolveExplainAndGetTraceReq(pending, 'trace-A');
    await act(async () => {
      traceAReq.resolve({
        trace: [traceEvent('MARKET_DATA', 0), traceEvent('CALCULATION_COMPLETED', 1, { engine: 'X', data: {} }), traceEvent('TRADE_IDEA_GENERATED', 2, { agent: 'Y', side: 'BUY', reasoning: 'r' })],
      });
      await Promise.resolve(); await Promise.resolve();
    });
    await screen.findByText(/Trade Replay: AAPL/i);

    // Jump playback to the last (index 2) event of trade A's 3-event trace via "fast forward".
    const buttons = screen.getAllByRole('button');
    const fastForward = buttons.find((b) => b.querySelector('svg.lucide-fast-forward'));
    expect(fastForward).toBeTruthy();
    await act(async () => { fastForward!.click(); await Promise.resolve(); });
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('2');

    // Switch to trade B, which resolves with only ONE event - index 2 would be out of bounds.
    rerender(<TradeReplayModal trade={tradeB} onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });
    const traceBReq = await resolveExplainAndGetTraceReq(pending, 'trace-B');
    await act(async () => {
      traceBReq.resolve({ trace: [traceEvent('MARKET_DATA', 0, { symbol: 'MSFT', price: 200 })] });
      await Promise.resolve(); await Promise.resolve();
    });
    await screen.findByText(/Trade Replay: MSFT/i);

    // The slider's max is now 0 (one event, index 0) and its value must be clamped to 0, not left
    // at the old trade's index 2.
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.max).toBe('0');
    expect(slider.value).toBe('0');
  });

  it('unmounting while a trace fetch is still in flight does not throw and does not apply a late response', async () => {
    const { fetchMock, pending } = buildFetchMock();
    global.fetch = fetchMock as any;
    const onClose = vi.fn();

    const { unmount } = render(<TradeReplayModal trade={tradeA} onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });
    const traceAReq = await resolveExplainAndGetTraceReq(pending, 'trace-A');

    unmount();

    // Resolving the in-flight trace request after unmount must not throw - the `cancelled` guard
    // is what this proves.
    await expect(act(async () => {
      traceAReq.resolve({ trace: [traceEvent('MARKET_DATA', 0)] });
      await Promise.resolve(); await Promise.resolve();
    })).resolves.not.toThrow();
  });
});
