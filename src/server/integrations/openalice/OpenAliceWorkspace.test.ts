import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureArgusWorkspaceId, _resetArgusWorkspaceCacheForTests } from './OpenAliceWorkspace';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('OpenAliceWorkspace', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    _resetArgusWorkspaceCacheForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('returns the existing workspace id when Argus-Core already exists', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { workspaces: [{ id: 'ws-existing', tag: 'argus-core' }] }),
    ) as any;

    const id = await ensureArgusWorkspaceId();

    expect(id).toBe('ws-existing');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('creates the workspace when none exists, and returns its new id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { workspaces: [] }))
      .mockResolvedValueOnce(jsonResponse(201, { workspace: { id: 'ws-new', tag: 'argus-core' } }));
    global.fetch = fetchMock as any;

    const id = await ensureArgusWorkspaceId();

    expect(id).toBe('ws-new');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createCall = fetchMock.mock.calls[1];
    expect(createCall[1]?.method).toBe('POST');
    expect(JSON.parse(createCall[1]?.body as string)).toEqual({ tag: 'argus-core' });
  });

  it('re-lists on a 409 (another process created it first) instead of failing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { workspaces: [] }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'tag_in_use' }))
      .mockResolvedValueOnce(jsonResponse(200, { workspaces: [{ id: 'ws-race', tag: 'argus-core' }] }));
    global.fetch = fetchMock as any;

    const id = await ensureArgusWorkspaceId();

    expect(id).toBe('ws-race');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns null, never throws, when the OpenAlice web port is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as any;

    const id = await ensureArgusWorkspaceId();

    expect(id).toBeNull();
  });

  it('caches the resolved id so a second call makes no further network requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { workspaces: [{ id: 'ws-cached', tag: 'argus-core' }] }),
    );
    global.fetch = fetchMock as any;

    const first = await ensureArgusWorkspaceId();
    const second = await ensureArgusWorkspaceId();

    expect(first).toBe('ws-cached');
    expect(second).toBe('ws-cached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight lookup across concurrent callers', async () => {
    let resolveFetch: (v: Response) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    global.fetch = fetchMock as any;

    const p1 = ensureArgusWorkspaceId();
    const p2 = ensureArgusWorkspaceId();
    resolveFetch(jsonResponse(200, { workspaces: [{ id: 'ws-shared', tag: 'argus-core' }] }));

    expect(await p1).toBe('ws-shared');
    expect(await p2).toBe('ws-shared');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
