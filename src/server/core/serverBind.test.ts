import { describe, it, expect } from 'vitest';
import { resolveListenHost, isAllowedCorsOrigin } from './serverBind';

describe('serverBind', () => {
  it('defaults to loopback when auth is disabled', () => {
    expect(resolveListenHost(false, {})).toBe('127.0.0.1');
  });

  it('defaults to all interfaces when auth is enabled', () => {
    expect(resolveListenHost(true, {})).toBe('0.0.0.0');
  });

  it('honors ARGUS_BIND_HOST override', () => {
    expect(resolveListenHost(false, { ARGUS_BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('allows Tailscale and LAN origins for credentialed CORS', () => {
    expect(isAllowedCorsOrigin('http://100.64.1.5:3000')).toBe(true);
    expect(isAllowedCorsOrigin('https://argus.tail123456.ts.net')).toBe(true);
    expect(isAllowedCorsOrigin('http://192.168.1.42:3000')).toBe(true);
    expect(isAllowedCorsOrigin('https://evil.example.com')).toBe(false);
  });
});
