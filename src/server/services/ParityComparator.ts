/**
 * Shadow-parity comparison between TypeScript-computed and Java-computed indicator snapshots
 * (docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md Phase 2). Pure comparison logic only
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
