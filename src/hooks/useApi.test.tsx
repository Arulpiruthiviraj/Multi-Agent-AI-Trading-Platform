// @vitest-environment happy-dom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useApi, useApiMutation, __inflightCount, type UseApiOptions } from './useApi';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function Probe({ path, options }: { path: string | null; options?: UseApiOptions<{ value: number }> }) {
  const r = useApi<{ value: number }>(path, options);
  return (
    <div>
      <div data-testid="data">{r.data ? String(r.data.value) : 'nodata'}</div>
      <div data-testid="error">{r.error ?? 'noerror'}</div>
      <div data-testid="loading">{String(r.loading)}</div>
      <div data-testid="refreshing">{String(r.refreshing)}</div>
      <div data-testid="unauthorized">{String(r.unauthorized)}</div>
      <button data-testid="refetch" onClick={r.refetch}>refetch</button>
    </div>
  );
}

/** Flush all pending promise chains (fetch mock resolutions, state updates). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useApi', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ value: 42 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads data on mount and clears loading', async () => {
    render(<Probe path="/api/v2/test" />);
    expect(screen.getByTestId('loading').textContent).toBe('true');
    await flush();
    expect(screen.getByTestId('data').textContent).toBe('42');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe('noerror');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/test');
    // Session cookie is always sent (Tailscale/LAN safe).
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  it('surfaces HTTP errors as a readable message', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: 'risk gate blocked' }, 422),
    );
    render(<Probe path="/api/v2/test" />);
    await flush();
    expect(screen.getByTestId('error').textContent).toBe('risk gate blocked');
    expect(screen.getByTestId('data').textContent).toBe('nodata');
  });

  it('flags 401 as unauthorized (session expired)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, 401));
    render(<Probe path="/api/v2/test" />);
    await flush();
    expect(screen.getByTestId('unauthorized').textContent).toBe('true');
    expect(screen.getByTestId('error').textContent).toContain('Session expired');
  });

  it('does not fetch when disabled or path is null', async () => {
    render(<Probe path={null} />);
    render(<Probe path="/api/v2/test" options={{ enabled: false }} />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deduplicates in-flight GETs across hook instances', async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    render(
      <>
        <Probe path="/api/v2/shared" />
        <Probe path="/api/v2/shared" />
      </>,
    );
    await flush();
    // Both instances mounted while the first request was still in flight:
    // only one network request should exist.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(__inflightCount()).toBe(1);
    await act(async () => {
      release(jsonResponse({ value: 7 }));
    });
    await flush();
    const datas = screen.getAllByTestId('data');
    expect(datas.every((d) => d.textContent === '7')).toBe(true);
    expect(__inflightCount()).toBe(0);
  });

  it('polls on schedule-next-after-complete and refetch resets the schedule', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse({ value: 1 }));
    render(<Probe path="/api/v2/poll" options={{ pollIntervalMs: 5000 }} />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Manual refetch fires immediately…
    await act(async () => {
      screen.getByTestId('refetch').click();
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // …and the poll schedule restarts from the manual fetch (no double-fire).
    await act(async () => {
      vi.advanceTimersByTime(4999);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('skips poll ticks while the document is hidden', async () => {
    vi.useFakeTimers();
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get');
    try {
      render(<Probe path="/api/v2/poll" options={{ pollIntervalMs: 1000 }} />);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      hiddenSpy.mockReturnValue(true);
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      await flush();
      // No additional network traffic while hidden.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      hiddenSpy.mockReturnValue(false);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      hiddenSpy.mockRestore();
    }
  });

  it('ignores stale responses after unmount (no setState on unmounted)', async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { unmount } = render(<Probe path="/api/v2/slow" />);
    await flush();
    unmount();
    // Resolving after unmount must not throw or warn.
    await act(async () => {
      release(jsonResponse({ value: 9 }));
    });
    await flush();
  });
});

describe('useApiMutation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function MutProbe() {
    const m = useApiMutation<{ ok: boolean }, { symbol: string }>('/api/v2/orders', 'POST');
    return (
      <div>
        <div data-testid="mdata">{m.data ? 'done' : 'nodata'}</div>
        <div data-testid="merror">{m.error ?? 'noerror'}</div>
        <div data-testid="mloading">{String(m.loading)}</div>
        <button data-testid="go" onClick={() => void m.mutate({ symbol: 'AAPL' })}>go</button>
      </div>
    );
  }

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('POSTs JSON vars and exposes the result', async () => {
    render(<MutProbe />);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      screen.getByTestId('go').click();
    });
    await flush();
    expect(screen.getByTestId('mdata').textContent).toBe('done');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ symbol: 'AAPL' });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('surfaces mutation errors', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'denied' }, 403));
    render(<MutProbe />);
    await act(async () => {
      screen.getByTestId('go').click();
    });
    await flush();
    expect(screen.getByTestId('merror').textContent).toBe('denied');
  });
});
