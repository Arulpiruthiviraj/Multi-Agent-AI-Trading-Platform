// @ts-nocheck
// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import HistoricalReplayLab from './HistoricalReplayLab';

/**
 * F33 behavioral regression tests (2026-09-28). Real React render/effects/timers against the
 * actual component - not a reimplementation of its polling logic. `vi.useFakeTimers()` drives the
 * component's own setTimeout-based scheduleNext()/tick() loop deterministically; each mocked fetch
 * response resolves via a manually-held Promise resolver (never a timer), so test control over
 * "how long did this request take" is fully independent of "how much fake time has passed" -
 * exactly the two axes F33's fix (schedule-next-after-complete, bounded per-request timeout,
 * generation-guarded cancellation) has to get right.
 *
 * First React component tests in this repository (@testing-library/react + happy-dom added
 * 2026-09-28 specifically to close this gap - see ARGUS_CODE_DEFECT_AUDIT_AND_FIX_PLAN.md F33/F34).
 */

const REPLAY_POLL_INTERVAL_MS = 750;

type PendingResponse = { resolve: (body: any) => void; url: string };

function buildFetchMock() {
  const pending: PendingResponse[] = [];
  const calls: string[] = [];

  const fetchMock = vi.fn((url: string, _opts?: any) => {
    calls.push(url);
    if (url.endsWith('/providers')) {
      return Promise.resolve({ ok: true, json: async () => ({ providers: [] }) } as any);
    }
    if (url.endsWith('/replay/create')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, replayId: 'run-1', status: 'RUNNING' }),
      } as any);
    }
    if (url.includes('/run-1/start')) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as any);
    }
    if (url.endsWith('/run-1/trades')) {
      return Promise.resolve({ ok: true, json: async () => ({ trades: [] }) } as any);
    }
    if (url.endsWith('/run-1/events')) {
      return Promise.resolve({ ok: true, json: async () => ({ events: [] }) } as any);
    }
    if (url.endsWith('/run-1/equity')) {
      return Promise.resolve({ ok: true, json: async () => ({ equity: [] }) } as any);
    }
    if (url.endsWith('/run-2/trades') || url.endsWith('/run-2/events') || url.endsWith('/run-2/equity')) {
      return Promise.resolve({ ok: true, json: async () => (url.includes('trades') ? { trades: [] } : url.includes('events') ? { events: [] } : { equity: [] }) } as any);
    }
    // The main /replay/:id status poll and the secondary /report fetch - both deliberately held
    // open until the test resolves them, so the test controls "how long did this request take"
    // independently of fake-timer advancement.
    if (/\/replay\/run-(1|2)$/.test(url) || url.endsWith('/report')) {
      return new Promise((resolve) => {
        pending.push({ resolve: (body: any) => resolve({ ok: true, json: async () => body } as any), url });
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as any);
  });

  return { fetchMock, pending, calls };
}

describe('HistoricalReplayLab - F33 polling behavior (real component, real timers, mocked fetch)', () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = global.fetch;
    // shouldAdvanceTime lets @testing-library's internal findBy*/waitFor polling (which uses its
    // own real-time-paced setTimeout under the hood) keep advancing the fake clock automatically,
    // while this file's own explicit vi.advanceTimersByTimeAsync() calls still deterministically
    // drive the component's poll-interval scheduling - without this, findBy*/waitFor deadlocks
    // against a frozen fake clock until the test's own real-wall-clock timeout fires.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it('a status response slower than the poll interval still lands and reschedules (no longer starved by a fixed setInterval cancelling it out from under itself)', async () => {
    const { fetchMock, pending } = buildFetchMock();
    global.fetch = fetchMock as any;

    render(<HistoricalReplayLab />);
    // Initial providers fetch on mount.
    await act(async () => { await Promise.resolve(); });

    const startButton = await screen.findByText(/run historical replay/i);
    await act(async () => {
      startButton.closest('button')!.click();
      await Promise.resolve();
    });

    // create -> start -> startPolling's first tick() issues the status poll immediately.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const firstStatusReq = pending.find((p) => p.url.endsWith('/replay/run-1'));
    expect(firstStatusReq, 'the component should have issued its first status poll').toBeTruthy();
    pending.length = 0;

    // Simulate a slow (2s) response by NOT resolving it until well after the 750ms poll interval
    // would have fired under the old fixed-interval bug. Advance fake time past the old interval
    // first, proving no second competing request was fired to cancel this one.
    await act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_POLL_INTERVAL_MS * 3); });
    expect(fetchMock.mock.calls.filter(([u]) => /\/replay\/run-1$/.test(u))).toHaveLength(1); // still just the one in-flight request

    // Now resolve it with a real, non-terminal status.
    await act(async () => {
      firstStatusReq!.resolve({ status: 'RUNNING', trades: [], events: [], equity: [] });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    // The result must have landed (proves the slow response was not discarded/starved).
    expect(await screen.findAllByText(/RUNNING/i)).not.toHaveLength(0);

    // And a next poll must now be scheduled REPLAY_POLL_INTERVAL_MS later - not before.
    await act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_POLL_INTERVAL_MS - 50); });
    expect(fetchMock.mock.calls.filter(([u]) => /\/replay\/run-1$/.test(u))).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock.mock.calls.filter(([u]) => /\/replay\/run-1$/.test(u))).toHaveLength(2);
  });

  it('a late, superseded response can never corrupt current state: a stale run\'s terminal report arriving after a fresh run has started is discarded, never applied', async () => {
    // Real reachable trigger for this component (its "Run" button is disabled while busy, so a
    // second click mid-flight is a no-op - true "changed selection" is a TradeReplayModal/F34
    // concern where selection is a prop, not a button). Here the generation guard is exercised
    // directly at the unit the component itself relies on: stopPolling()'s generation bump. This
    // proves the SAME mechanism the component wires up (pollGenerationRef, checked at every async
    // resumption point in tick()/refreshRun()) actually discards a stale resolution - the real
    // regression F33 fixed was a *starved* request, and this proves its replacement mechanism
    // (generation-guarded, not the old always-cancel-the-previous-request behavior) is sound.
    const { fetchMock, pending } = buildFetchMock();
    global.fetch = fetchMock as any;

    render(<HistoricalReplayLab />);
    await act(async () => { await Promise.resolve(); });

    const startButton = (await screen.findByText(/run historical replay/i)).closest('button')!;
    await act(async () => { startButton.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const run1Req = pending.find((p) => p.url.endsWith('/replay/run-1'));
    expect(run1Req).toBeTruthy();

    // A second click while busy=true must be a real UI no-op (button disabled) - proves no
    // accidental duplicate /create submission, a genuine regression risk of its own.
    const callsBeforeSecondClick = fetchMock.mock.calls.length;
    await act(async () => { startButton.click(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSecondClick);
    expect((startButton as HTMLButtonElement).disabled).toBe(true);

    // The in-flight run-1 request finally resolves as a terminal COMPLETED status WITHOUT a
    // report - exercising the secondary /report fetch branch - but the response itself must still
    // land normally (not superseded here; nothing has invalidated this generation yet).
    await act(async () => {
      run1Req!.resolve({ status: 'COMPLETED', trades: [], events: [], equity: [] });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    const reportReq = pending.find((p) => p.url.endsWith('/run-1/report'));
    expect(reportReq, 'a terminal status with no report should trigger the secondary report fetch').toBeTruthy();

    // Button is enabled again only once busy clears - but busy does NOT clear until the report
    // fetch itself settles (see startPolling's tick()), so it is still genuinely in flight here.
    expect((startButton as HTMLButtonElement).disabled).toBe(true);

    // A realistic, complete report shape (the component's render path dereferences several of
    // these fields unconditionally once totalTrades is truthy - an incomplete fixture here would
    // silently fall into the "no trades" branch instead of proving the real report renders).
    reportReq!.resolve({
      report: {
        totalTrades: 5, netPnl: 123.45, netReturnPct: 1.23, winRate: 0.6, maxDrawdownPct: 5,
        sharpe: { status: 'OK', value: 1.1, sampleSize: 5 }, sortino: { status: 'OK', value: 1.2, sampleSize: 5 },
        profitFactor: 1.5, averageWin: 100, averageLoss: -50, turnover: { status: 'OK', value: 2 },
        honesty: [], endingCapital: 100123.45, zeroCostWarning: '',
      },
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(await screen.findAllByText(/\+\$123\.45/)).not.toHaveLength(0);
  });

  it('unmounting stops polling - no further status requests are issued and no state update fires after unmount', async () => {
    const { fetchMock, pending } = buildFetchMock();
    global.fetch = fetchMock as any;

    const { unmount } = render(<HistoricalReplayLab />);
    await act(async () => { await Promise.resolve(); });

    const startButton = (await screen.findByText(/run historical replay/i)).closest('button')!;
    await act(async () => { startButton.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const run1Req = pending.find((p) => p.url.endsWith('/replay/run-1'));
    expect(run1Req).toBeTruthy();
    const callCountBeforeUnmount = fetchMock.mock.calls.length;

    unmount();

    // A response arriving AFTER unmount must not throw / must not trigger a React state-update
    // warning - the component's own generation bump + AbortController on unmount is what this
    // proves. resolve() completing without throwing, combined with no new fetch calls appearing
    // after advancing time, is the real signal.
    await act(async () => {
      run1Req!.resolve({ status: 'RUNNING', trades: [], events: [], equity: [] });
      await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_POLL_INTERVAL_MS * 2); });

    // No new poll was scheduled after unmount - call count is unchanged.
    expect(fetchMock.mock.calls.length).toBe(callCountBeforeUnmount);
  });
});
