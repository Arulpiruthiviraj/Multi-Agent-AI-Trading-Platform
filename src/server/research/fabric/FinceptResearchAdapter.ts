/**
 * Read-only Fincept macro/fundamental normalizer. No broker keys. No OMS.
 * Requires publicReleaseDate on every metric — fail closed otherwise.
 */
import type { NormalizedEvidenceMetric, ResearchPacket } from './types';

export interface FinceptRawMetric {
  key: string;
  value: number | string | boolean | null;
  unit?: string;
  publicReleaseDate: number | string;
  asOfTimestamp?: number | string;
}

export interface FinceptRawPacket {
  symbol?: string | null;
  title?: string;
  metrics?: FinceptRawMetric[];
  category?: 'MACRO' | 'FUNDAMENTAL' | 'VALUATION';
}

function toMs(v: number | string | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export function normalizeFinceptPacket(raw: FinceptRawPacket): ResearchPacket {
  const metrics: NormalizedEvidenceMetric[] = [];
  for (const m of raw.metrics ?? []) {
    const publicReleaseDate = toMs(m.publicReleaseDate);
    if (publicReleaseDate == null) {
      throw new Error(`Fincept metric ${m.key} missing mandatory publicReleaseDate`);
    }
    const asOf = toMs(m.asOfTimestamp);
    metrics.push({
      key: String(m.key),
      value: m.value ?? null,
      unit: m.unit,
      publicReleaseDate,
      ...(asOf != null ? { asOfTimestamp: asOf } : {}),
    });
  }
  return {
    provider: 'FINCEPT',
    category: raw.category ?? 'MACRO',
    symbol: raw.symbol ?? null,
    title: raw.title ?? 'Fincept research packet',
    metrics,
    ingestedAt: Date.now(),
    trust: 'UNTRUSTED_READONLY',
    canPlaceOrders: false,
  };
}

/** No live Fincept in this environment — returns empty list honestly. */
export async function fetchFinceptPackets(_symbol?: string): Promise<ResearchPacket[]> {
  return [];
}
