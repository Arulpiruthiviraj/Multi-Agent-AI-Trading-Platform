/** Canonical research bar. Signal at bar T may use only fields on bars <= T. */

export interface ResearchBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  trade_count?: number;
  bid?: number;
  ask?: number;
  spread?: number;
}

export interface DatasetMetadata {
  datasetId: string;
  symbol: string;
  timezone: string;
  frequency: string;
  adjustmentPolicy: string;
  missingBarPolicy: string;
  duplicatePolicy: string;
  source: string;
  sourceVersion: string;
  market: string;
  downloadTimestamp?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  qualityStatus?: 'GREEN' | 'YELLOW' | 'RED' | 'UNAVAILABLE';
}

export interface CanonicalDataset extends DatasetMetadata {
  schemaVersion: number;
  bars: ResearchBar[];
  provenance?: DataProvenance;
}

export type DataQualityGrade = 'GREEN' | 'YELLOW' | 'RED';

export type DataProvenance =
  | 'REAL_MARKET_DATA'
  | 'SYNTHETIC_TEST_DATA'
  | 'UNIT_FIXTURE'
  | 'PAPER_DATA'
  | 'REPLAY_DATA'
  | 'UNKNOWN';

export type AdjustmentPolicy = 'RAW' | 'SPLIT_ADJUSTED' | 'TOTAL_RETURN' | 'unadjusted_synthetic';
