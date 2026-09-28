/**
 * SSRF guard for server-side outbound fetches to operator-supplied URLs (webhooks today; anything
 * else that takes a user-supplied URL and fetches it server-side should use this too).
 *
 * Real bug fixed: webhooks.ts stored and fetched arbitrary URLs with zero validation, and
 * triggerWebhooks() is wired to real trading/system events (AlertingService.ts,
 * OrderManagement.ts) - so a malicious stored webhook URL gets auto-re-fetched every time a real
 * event fires, not just once on manual test. This checks both the URL's literal hostname AND its
 * resolved IP (via a real DNS lookup) against the private/loopback/link-local/metadata ranges, so
 * a hostname that merely *resolves* to an internal address (DNS rebinding) is still blocked.
 */
import { promises as dns } from 'node:dns';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', 'metadata.google.internal']);

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ipLong: number, base: string, prefixLen: number): boolean {
  const baseLong = ipv4ToLong(base);
  if (baseLong === null) return false;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipLong & mask) === (baseLong & mask);
}

// Reserved/private/link-local/metadata IPv4 ranges - a URL resolving into any of these must never
// be fetched from a server process reachable from outside the host.
const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // includes the 169.254.169.254 cloud-metadata endpoint
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isBlockedIpv4(ip: string): boolean {
  const long = ipv4ToLong(ip);
  if (long === null) return false;
  return BLOCKED_IPV4_CIDRS.some(([base, len]) => inCidr(long, base, len));
}

function isBlockedIpv6(ip: string): boolean {
  // URL canonicalization normalizes expanded and dotted IPv4-mapped IPv6 forms.
  const lower = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  const prefix = parseInt(lower.split(':')[0] || '0', 16);
  if ((prefix & 0xffc0) === 0xfe80 || (prefix & 0xfe00) === 0xfc00 || (prefix & 0xff00) === 0xff00) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) - unwrap and check the embedded IPv4 address too.
  const mapped = lower.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return isBlockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

/** Exported for reuse by safeFetch.ts (F29): the connect-time transport must apply the exact same
 *  blocked-range policy to the address it is about to connect to, not a re-derived copy of it. */
export function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true;
}

export interface UrlSafetyResult {
  safe: boolean;
  reason?: string;
}

/** A single resolved, policy-checked address safe to connect to for a given URL - shared by
 *  isSafeOutboundUrl (config-time check) and safeFetch.ts's connect-time transport (F29), so both
 *  paths apply exactly the same resolution + policy, not two independently-maintained copies. */
export interface ResolvedSafeTarget {
  safe: true;
  hostname: string;
  /** First safe resolved address. safeFetch connects directly to this - it never re-resolves the
   *  hostname a second time, which is what would let DNS rebinding slip a connection through. */
  address: string;
  family: 4 | 6;
  protocol: 'http:' | 'https:';
  port: number;
}

export type UrlSafetyCheck = ResolvedSafeTarget | { safe: false; reason: string };

/** Real network validation (DNS lookup), not just string matching - resolves the hostname and
 *  checks every resolved address, so it can't be defeated by a domain that resolves to an internal
 *  IP (DNS rebinding / attacker-controlled DNS). Returns the resolved connect target on success so
 *  callers that actually open the connection (safeFetch.ts) can bind to the exact address that was
 *  validated instead of re-resolving the hostname later (F29). */
export async function checkUrlSafety(rawUrl: string): Promise<UrlSafetyCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Not a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Unsupported protocol "${parsed.protocol}" - only http/https are allowed.` };
  }
  if (parsed.username || parsed.password) return { safe: false, reason: 'URL credentials are not allowed.' };
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: `"${hostname}" is a blocked internal hostname.` };
  }
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      return { safe: false, reason: `"${hostname}" is a private/internal/reserved IP address.` };
    }
    return {
      safe: true,
      hostname,
      address: hostname,
      family: net.isIP(hostname) as 4 | 6,
      protocol: parsed.protocol as 'http:' | 'https:',
      port,
    };
  }
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (records.length === 0) return { safe: false, reason: 'No resolved addresses.' };
    for (const rec of records) {
      if (isBlockedIp(rec.address)) {
        return { safe: false, reason: `"${hostname}" resolves to ${rec.address}, a private/internal/reserved IP address.` };
      }
    }
    const first = records[0];
    return {
      safe: true,
      hostname,
      address: first.address,
      family: first.family as 4 | 6,
      protocol: parsed.protocol as 'http:' | 'https:',
      port,
    };
  } catch (e: any) {
    return { safe: false, reason: `Could not resolve "${hostname}": ${e.message}` };
  }
}

/** Back-compat convenience wrapper over checkUrlSafety for callers that only need the boolean
 *  verdict (config-time write validation in webhooks.ts) and not the resolved connect target. */
export async function isSafeOutboundUrl(rawUrl: string): Promise<UrlSafetyResult> {
  const result = await checkUrlSafety(rawUrl);
  return result.safe === false ? { safe: false, reason: result.reason } : { safe: true };
}
