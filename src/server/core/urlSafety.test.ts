import { describe, it, expect } from 'vitest';
import { isSafeOutboundUrl } from './urlSafety';

describe('isSafeOutboundUrl - SSRF guard', () => {
  it('rejects malformed URLs', async () => {
    const r = await isSafeOutboundUrl('not a url');
    expect(r.safe).toBe(false);
  });

  it('rejects non-http(s) protocols', async () => {
    const r = await isSafeOutboundUrl('file:///etc/passwd');
    expect(r.safe).toBe(false);
  });

  it('rejects loopback IPs by literal address', async () => {
    expect((await isSafeOutboundUrl('http://127.0.0.1/')).safe).toBe(false);
    expect((await isSafeOutboundUrl('http://127.0.0.1:8080/admin')).safe).toBe(false);
    expect((await isSafeOutboundUrl('http://[::1]/')).safe).toBe(false);
  });

  it('rejects the cloud metadata endpoint', async () => {
    const r = await isSafeOutboundUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.safe).toBe(false);
  });

  it('rejects private RFC1918 ranges', async () => {
    expect((await isSafeOutboundUrl('http://10.0.0.5/')).safe).toBe(false);
    expect((await isSafeOutboundUrl('http://172.16.0.1/')).safe).toBe(false);
    expect((await isSafeOutboundUrl('http://192.168.1.1/')).safe).toBe(false);
  });

  it('rejects the blocked "localhost" hostname', async () => {
    const r = await isSafeOutboundUrl('http://localhost:3000/internal');
    expect(r.safe).toBe(false);
  });

  it('rejects a hostname that fails to resolve, rather than allowing it through as unknown', async () => {
    const r = await isSafeOutboundUrl('http://this-domain-should-not-exist-argus-test.invalid/');
    expect(r.safe).toBe(false);
  });

  it('allows a real, non-private public hostname (Slack webhook host)', async () => {
    const r = await isSafeOutboundUrl('https://hooks.slack.com/services/T00/B00/X123');
    expect(r.safe).toBe(true);
  }, 10000);
});
