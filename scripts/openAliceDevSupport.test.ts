import { describe, it, expect, vi, afterEach } from 'vitest';
import { mcpEndpointIsOpenAlice, openAliceSkipReason, shouldSkipOpenAlice } from './openAliceDevSupport';

describe('shouldSkipOpenAlice', () => {
  it('starts by default (ENABLE_OPENALICE unset)', () => {
    expect(shouldSkipOpenAlice({})).toBe(false);
    expect(openAliceSkipReason({})).toBeNull();
  });

  it('skips when ARGUS_SKIP_OPENALICE=true', () => {
    expect(shouldSkipOpenAlice({ ARGUS_SKIP_OPENALICE: 'true' })).toBe(true);
    expect(openAliceSkipReason({ ARGUS_SKIP_OPENALICE: 'true' })).toMatch(/ARGUS_SKIP_OPENALICE/);
  });

  it('skips when ENABLE_OPENALICE=false even if ARGUS_SKIP_OPENALICE is unset', () => {
    expect(shouldSkipOpenAlice({ ENABLE_OPENALICE: 'false' })).toBe(true);
    expect(openAliceSkipReason({ ENABLE_OPENALICE: 'false' })).toMatch(/ENABLE_OPENALICE=false/);
  });

  it('starts when ENABLE_OPENALICE=true', () => {
    expect(shouldSkipOpenAlice({ ENABLE_OPENALICE: 'true' })).toBe(false);
  });
});

describe('mcpEndpointIsOpenAlice', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function textResponse(status: number, body: string) {
    return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
  }

  it('accepts an SSE-framed initialize response identifying as open-alice', async () => {
    // Confirmed live (2026-08-18): OpenAlice's real Streamable HTTP transport answers this way -
    // content-type: text/event-stream, body as "event: message\ndata: {...}", not plain JSON.
    const sse = 'event: message\ndata: {"result":{"serverInfo":{"name":"open-alice","version":"1.0.0"}},"jsonrpc":"2.0","id":1}';
    global.fetch = vi.fn().mockResolvedValue(textResponse(200, sse)) as any;

    const result = await mcpEndpointIsOpenAlice('http://127.0.0.1:47332/mcp');

    expect(result.ok).toBe(true);
  });

  it('accepts a plain-JSON initialize response identifying as open-alice', async () => {
    const json = JSON.stringify({ result: { serverInfo: { name: 'open-alice', version: '1.0.0' } }, jsonrpc: '2.0', id: 1 });
    global.fetch = vi.fn().mockResolvedValue(textResponse(200, json)) as any;

    const result = await mcpEndpointIsOpenAlice('http://127.0.0.1:47332/mcp');

    expect(result.ok).toBe(true);
  });

  it('rejects a server identifying as something other than open-alice', async () => {
    const sse = 'event: message\ndata: {"result":{"serverInfo":{"name":"some-other-mcp"}},"jsonrpc":"2.0","id":1}';
    global.fetch = vi.fn().mockResolvedValue(textResponse(200, sse)) as any;

    const result = await mcpEndpointIsOpenAlice('http://127.0.0.1:47332/mcp');

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/some-other-mcp/);
  });

  it('reports unreachable, never throws, on a network failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as any;

    const result = await mcpEndpointIsOpenAlice('http://127.0.0.1:47332/mcp');

    expect(result.ok).toBe(false);
  });
});
