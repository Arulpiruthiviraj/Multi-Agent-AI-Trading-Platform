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

/**
 * Chronos/Kronos Python (`scripts/local_ai_service.py`) listens on LOCAL_AI_SERVICE_PORT
 * (default 8008). Older docs used :8000 — remap so Diagnostics never probes the wrong port.
 */
export function resolveLocalAiServiceUrl(raw?: string): string {
  const port = process.env.LOCAL_AI_SERVICE_PORT || '8008';
  const input = raw ?? process.env.LOCAL_AI_SERVICE_URL ?? `http://127.0.0.1:${port}`;
  return preferIpv4Loopback(input.replace(/:8000(?=\/|$)/, ':8008'));
}
