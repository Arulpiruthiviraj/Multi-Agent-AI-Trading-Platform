/**
 * AutoHedge signal intake → read-only EXTERNAL_THESIS packets.
 * Never executes hedges. Wallet keys stripped. No OMS.
 */
import type { ResearchPacket } from './types';

export interface AutoHedgeRawSignal {
  symbol?: string | null;
  thesis?: string;
  sideHint?: 'BUY' | 'SELL' | 'HOLD' | string;
  confidence?: number;
  publicReleaseDate: number | string;
  asOfTimestamp?: number | string;
  walletKey?: string;
  privateKey?: string;
}

function toMs(v: number | string | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export function normalizeAutoHedgeSignal(raw: AutoHedgeRawSignal): ResearchPacket {
  const publicReleaseDate = toMs(raw.publicReleaseDate);
  if (publicReleaseDate == null) {
    throw new Error('AutoHedge signal missing mandatory publicReleaseDate');
  }
  const asOf = toMs(raw.asOfTimestamp);
  // Intentionally ignore walletKey / privateKey — never persist or forward.
  return {
    provider: 'AUTOHEDGE',
    category: 'EXTERNAL_THESIS',
    symbol: raw.symbol ?? null,
    title: raw.thesis ?? 'AutoHedge external thesis',
    metrics: [
      {
        key: 'sideHint',
        value: raw.sideHint ?? null,
        publicReleaseDate,
        ...(asOf != null ? { asOfTimestamp: asOf } : {}),
      },
      {
        key: 'confidence',
        value: raw.confidence ?? null,
        publicReleaseDate,
        ...(asOf != null ? { asOfTimestamp: asOf } : {}),
      },
    ],
    ingestedAt: Date.now(),
    trust: 'UNTRUSTED_READONLY',
    canPlaceOrders: false,
  };
}

/** No live AutoHedge feed wired — empty by default. */
export async function fetchAutoHedgePackets(_symbol?: string): Promise<ResearchPacket[]> {
  return [];
}
