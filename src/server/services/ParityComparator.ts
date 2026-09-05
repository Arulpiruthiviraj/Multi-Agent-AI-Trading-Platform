/**
 * Shadow-parity comparison between TypeScript-computed and Java-computed indicator snapshots
 * (docs/architecture/ARGUS_ARCHITECTURE.md (Java Quant Core section) Phase 2). Pure comparison logic only
 * - no network, no EventBus, never touches ChiefTrader/RiskEngine. QuantCoreBridge.ts calls
 * compareSnapshots() with the two already-fetched/computed snapshots and logs the result.
 */
import { tradingSafety } from '../config/tradingSafety';

export interface ComparableIndicatorSnapshot {
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  bbUpper: number | null;
  bbLower: number | null;
}

export interface FieldDivergence {
  field: string;
  tsValue: number;
  javaValue: number;
  diffPct: number;
}

/**
 * Compares each field present in BOTH snapshots (a field null on either side is skipped, never
 * treated as a 0-vs-0 false match or a fabricated divergence). diffPct is |ts - java| / |ts|,
 * matching the blueprint's own ">0.01%" framing. A ts value of exactly 0 is skipped (division by
 * zero would produce a meaningless ratio, not a real divergence reading).
 */
export function compareSnapshots(
  ts: ComparableIndicatorSnapshot,
  java: ComparableIndicatorSnapshot,
  thresholdPct: number = tradingSafety.quantJavaCoreDivergenceThresholdPct,
): FieldDivergence[] {
  const fields: (keyof ComparableIndicatorSnapshot)[] = ['rsi', 'macd', 'macdSignal', 'bbUpper', 'bbLower'];
  const divergences: FieldDivergence[] = [];

  for (const field of fields) {
    const tsValue = ts[field];
    const javaValue = java[field];
    if (tsValue === null || javaValue === null || tsValue === 0) continue;

    const diffPct = Math.abs(tsValue - javaValue) / Math.abs(tsValue);
    if (diffPct > thresholdPct) {
      divergences.push({ field, tsValue, javaValue, diffPct });
    }
  }

  return divergences;
}

/**
 * QuantSignalAgent.evaluateSymbol()'s RegimeEngine.classifyRegime(bars) shadow-parity companion
 * to compareSnapshots() above (QuantCoreBridge.compareRegimeParity). Deliberately TOP-LEVEL fields
 * only (regime/trendStrength/volatility/marketStructure/confidence) - the nested trend/volatility/
 * priceAction feature sub-objects on RegimeResult are NOT diffed here (disclosed scope reduction,
 * matching the Java-side route's own comment); a full nested-feature parity comparison is a larger
 * follow-up, not attempted in this pass.
 */
export interface ComparableRegimeSnapshot {
  regime: string;
  trendStrength: number;
  volatility: string;
  marketStructure: string;
  confidence: number;
}

export interface RegimeFieldDivergence {
  field: string;
  tsValue: string | number;
  javaValue: string | number;
  diffPct?: number; // present only for the two numeric fields (trendStrength/confidence)
}

/**
 * regime/volatility/marketStructure are enum-like strings - divergence there is a real classification
 * disagreement (exact string mismatch, no percentage), not a rounding difference. trendStrength/
 * confidence are numeric and use the same diffPct-over-threshold convention as compareSnapshots
 * (a value of exactly 0 on the TS side is skipped, same division-by-zero rationale).
 */
export function compareRegimeSnapshots(
  ts: ComparableRegimeSnapshot,
  java: ComparableRegimeSnapshot,
  thresholdPct: number = tradingSafety.quantJavaCoreDivergenceThresholdPct,
): RegimeFieldDivergence[] {
  const divergences: RegimeFieldDivergence[] = [];

  const stringFields: (keyof ComparableRegimeSnapshot)[] = ['regime', 'volatility', 'marketStructure'];
  for (const field of stringFields) {
    if (ts[field] !== java[field]) {
      divergences.push({ field, tsValue: ts[field], javaValue: java[field] });
    }
  }

  const numericFields: (keyof ComparableRegimeSnapshot)[] = ['trendStrength', 'confidence'];
  for (const field of numericFields) {
    const tsValue = ts[field] as number;
    const javaValue = java[field] as number;
    if (tsValue === 0 || !Number.isFinite(tsValue) || !Number.isFinite(javaValue)) continue;

    const diffPct = Math.abs(tsValue - javaValue) / Math.abs(tsValue);
    if (diffPct > thresholdPct) {
      divergences.push({ field, tsValue, javaValue, diffPct });
    }
  }

  return divergences;
}
