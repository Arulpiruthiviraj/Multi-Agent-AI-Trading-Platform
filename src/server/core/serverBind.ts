/** Listen address for HTTP/WebSocket — remote mobile requires non-loopback when auth is on. */
export function resolveListenHost(authEnabled: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ARGUS_BIND_HOST?.trim();
  if (explicit) return explicit;
  return authEnabled ? '0.0.0.0' : '127.0.0.1';
}

/** True when an Origin header should receive credentialed CORS (Tailscale / LAN dev). */
export function isAllowedCorsOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.endsWith('.ts.net')) return true;
    if (host.startsWith('100.')) return true; // Tailscale CGNAT
    if (host.startsWith('192.168.')) return true;
    if (host.startsWith('10.')) return true;
    return false;
  } catch {
    return false;
  }
}
