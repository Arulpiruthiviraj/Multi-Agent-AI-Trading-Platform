import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveWebSocketUrl } from './clientFetch';

describe('clientFetch remote connectivity helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: '100.64.1.5:3000' },
    } as Window & typeof globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolveWebSocketUrl uses current host, not localhost', () => {
    expect(resolveWebSocketUrl()).toBe('ws://100.64.1.5:3000/ws');
  });

  it('uses wss when page is https', () => {
    vi.stubGlobal('window', {
      location: { protocol: 'https:', host: 'argus.tail123456.ts.net' },
    } as Window & typeof globalThis);
    expect(resolveWebSocketUrl()).toBe('wss://argus.tail123456.ts.net/ws');
  });
});
