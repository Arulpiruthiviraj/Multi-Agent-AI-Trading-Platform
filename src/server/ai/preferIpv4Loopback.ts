/**
 * Windows Node often resolves `localhost` to `::1` while Python's ThreadingHTTPServer
 * binds `127.0.0.1` only. That shows up as `fetch failed` on Chronos even when /health
 * is up on IPv4. Loopback-only rewrite; never touches non-local hosts.
 */
export function preferIpv4Loopback(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1';
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/$/, '');
  }
}
