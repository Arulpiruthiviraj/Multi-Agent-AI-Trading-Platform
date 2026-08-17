/**
 * Point-in-time research fabric types. Evidence-only — never OMS/broker authority.
 */
export type ResearchCategory =
  | 'MACRO'
  | 'FUNDAMENTAL'
  | 'VALUATION'
  | 'ALPHA_FACTOR'
  | 'EXTERNAL_THESIS';

export interface NormalizedEvidenceMetric {
  key: string;
  value: number | string | boolean | null;
  unit?: string;
  /** Unix ms when the metric became public / knowable. Required for PIT. */
  publicReleaseDate: number;
  /** Optional as-of / revision timestamp (must still be <= decision bar). */
  asOfTimestamp?: number;
}

export interface ResearchPacket {
  provider: 'FINCEPT' | 'VIBE_TRADING' | 'AUTOHEDGE' | 'INTERNAL' | 'UNKNOWN';
  category: ResearchCategory;
  symbol: string | null;
  title: string;
  metrics: NormalizedEvidenceMetric[];
  /** When this packet was ingested into Argus (not usable for look-ahead). */
  ingestedAt: number;
  trust: 'UNTRUSTED_READONLY';
  canPlaceOrders: false;
  rawRef?: string;
}

export interface PitValidationResult {
  ok: boolean;
  rejectedMetrics: Array<{ key: string; reason: string; publicReleaseDate: number; currentBarTimestamp: number }>;
  acceptedMetricCount: number;
}
