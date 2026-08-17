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
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true; // link-local + unique-local
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) - unwrap and check the embedded IPv4 address too.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return false;
}

function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return false;
}

export interface UrlSafetyResult {
  safe: boolean;
  reason?: string;
}

/** Real network validation (DNS lookup), not just string matching - resolves the hostname and
 * checks every resolved address, so it can't be defeated by a domain that resolves to an internal
 * IP (DNS rebinding / attacker-controlled DNS). */
export async function isSafeOutboundUrl(rawUrl: string): Promise<UrlSafetyResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'Not a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Unsupported protocol "${parsed.protocol}" - only http/https are allowed.` };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: `"${hostname}" is a blocked internal hostname.` };
  }
  if (net.isIP(hostname) && isBlockedIp(hostname)) {
    return { safe: false, reason: `"${hostname}" is a private/internal/reserved IP address.` };
  }
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const rec of records) {
      if (isBlockedIp(rec.address)) {
        return { safe: false, reason: `"${hostname}" resolves to ${rec.address}, a private/internal/reserved IP address.` };
      }
    }
  } catch (e: any) {
    return { safe: false, reason: `Could not resolve "${hostname}": ${e.message}` };
  }
  return { safe: true };
}
