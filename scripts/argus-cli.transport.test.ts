import { afterEach, expect, it, vi } from 'vitest';
import { fetchJson } from './argus-cli';

afterEach(() => vi.unstubAllGlobals());

it('distinguishes an unreachable engine without exposing transport secrets', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('secret url', { cause: { code: 'ECONNREFUSED' } })));
  await expect(fetchJson('/api/v2/runtime/orders?private=value')).rejects.toThrow(/ENGINE_UNREACHABLE: GET \/api\/v2\/runtime\/orders after \d+ms/);
});

it('keeps server correlation when the response body times out', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    headers: new Headers({ 'x-request-id': 'server-request' }),
    text: async () => { controller.abort(); throw new Error('timeout'); },
  }));
  await expect(fetchJson('/api/v2/runtime/orders', { signal: controller.signal }))
    .rejects.toThrow(/REQUEST_ABORTED_OR_TIMED_OUT:.*requestId=server-request/);
});
