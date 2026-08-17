/**
 * Local MCP client for vibe-trading factor analytics (default :8900).
 * Read-only. Strips any wallet/credential fields. Never places orders.
 */
import type { ResearchPacket } from './types';

const DEFAULT_URL = process.env.VIBE_TRADING_MCP_URL || 'http://127.0.0.1:8900';

function stripSecrets(obj: unknown): unknown {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (
      key.includes('wallet')
      || key.includes('private')
      || key.includes('secret')
      || key.includes('api_key')
      || key.includes('apikey')
      || key.includes('credential')
    ) {
      continue;
    }
    out[k] = stripSecrets(v);
  }
  return out;
}

export async function queryVibeTool(
  tool: 'alpha_zoo' | 'quantlib_call',
  args: Record<string, unknown> = {},
  baseUrl = DEFAULT_URL,
): Promise<{ ok: boolean; available: boolean; data: unknown; error?: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/tools/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'ArgusResearch/1.0' },
      body: JSON.stringify(stripSecrets(args)),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      return { ok: false, available: true, data: null, error: `HTTP_${res.status}` };
    }
    const data = stripSecrets(await res.json());
    return { ok: true, available: true, data, error: undefined };
  } catch (e: any) {
    return { ok: false, available: false, data: null, error: e?.message || 'VIBE_UNAVAILABLE' };
  }
}

export function normalizeVibeFactorPacket(
  symbol: string,
  tool: 'alpha_zoo' | 'quantlib_call',
  payload: unknown,
  publicReleaseDate: number,
): ResearchPacket {
  const metrics = [];
  if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' || value == null) {
        metrics.push({
          key: `${tool}.${key}`,
          value: value as number | string | boolean | null,
          publicReleaseDate,
        });
      }
    }
  }
  return {
    provider: 'VIBE_TRADING',
    category: 'ALPHA_FACTOR',
    symbol,
    title: `Vibe ${tool}`,
    metrics,
    ingestedAt: Date.now(),
    trust: 'UNTRUSTED_READONLY',
    canPlaceOrders: false,
    rawRef: tool,
  };
}

export async function fetchVibePackets(symbol: string, asOfBarMs: number): Promise<ResearchPacket[]> {
  const out: ResearchPacket[] = [];
  for (const tool of ['alpha_zoo', 'quantlib_call'] as const) {
    const r = await queryVibeTool(tool, { symbol, asOf: asOfBarMs });
    if (r.ok && r.data) {
      out.push(normalizeVibeFactorPacket(symbol, tool, r.data, asOfBarMs));
    }
  }
  return out;
}
