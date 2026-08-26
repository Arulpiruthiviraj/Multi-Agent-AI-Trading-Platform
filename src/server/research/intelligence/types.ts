/**
 * ==========================================================
 * Module: research/intelligence/types
 *
 * Safe Research & Quant Intelligence Expansion (2026-08-25). Shared shapes for the 12 new
 * research/advisory capabilities. Every capability returns a ResearchResult<T> — nothing in this
 * directory returns a bare value with no provenance, because "how do you know that" must always be
 * answerable from the object itself, not from trusting the caller.
 *
 * This directory is READ-ONLY with respect to trading: no file here may import ChiefTraderAgent,
 * RiskEngine, OrderManagement, or BrokerManager, or call anything named placeOrder. Enforced by
 * researchIntelligenceBoundary.test.ts.
 * ==========================================================
 */
import { randomUUID } from 'crypto';

/** Reused, not redefined — the existing strategy graduation ladder (promotionEngine.ts). */
export type { StrategyLifecycleStatus } from '../promotionEngine';

export type DataQualityGrade = 'GREEN' | 'YELLOW' | 'RED' | 'UNAVAILABLE';

export interface DataQualityMeta {
  source: string;
  symbol?: string;
  timeframe?: string;
  timestamp: string;
  sampleSize: number;
  missingFields: string[];
  staleness: 'FRESH' | 'STALE' | 'UNKNOWN';
  assumptions: string[];
  quality: DataQualityGrade;
}

export function unavailableDataQuality(source: string, reason: string, symbol?: string): DataQualityMeta {
  return {
    source,
    symbol,
    timestamp: new Date().toISOString(),
    sampleSize: 0,
    missingFields: [reason],
    staleness: 'UNKNOWN',
    assumptions: [],
    quality: 'UNAVAILABLE',
  };
}

/** Every research artifact — never an order, never counted as live/organic trading activity. */
export interface ResearchResult<T> {
  researchRunId: string;
  capability: string;
  label: 'RESEARCH' | 'ADVISORY';
  canPlaceOrders: false;
  isLiveTrade: false;
  generatedAt: string;
  dataQuality: DataQualityMeta;
  data: T;
}

export function newResearchRunId(): string {
  return `research-${randomUUID()}`;
}

export function wrapResearchResult<T>(opts: {
  capability: string;
  label?: 'RESEARCH' | 'ADVISORY';
  dataQuality: DataQualityMeta;
  data: T;
  researchRunId?: string;
}): ResearchResult<T> {
  return {
    researchRunId: opts.researchRunId ?? newResearchRunId(),
    capability: opts.capability,
    label: opts.label ?? 'RESEARCH',
    canPlaceOrders: false,
    isLiveTrade: false,
    generatedAt: new Date().toISOString(),
    dataQuality: opts.dataQuality,
    data: opts.data,
  };
}
