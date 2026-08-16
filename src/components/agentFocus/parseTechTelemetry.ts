/**
 * Unwrap MARKET_DATA / TECHNICAL_ANALYSIS_COMPLETED / CALCULATION_COMPLETED payloads.
 * TechnicalAgent emits flat fields on TECHNICAL_ANALYSIS_COMPLETED and nested
 * `{ engine, symbol, data }` on CALCULATION_COMPLETED. AdvancedQuantEngine calcs
 * have no RSI/MACD and must not be treated as Technical Agent series points.
 */

export function unwrapTechPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.data && typeof p.data === 'object') return p.data as Record<string, unknown>;
  return p;
}

export function isTechnicalEngineCalc(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (p.engine === 'AdvancedQuantEngine') return false;
  if (p.engine === 'TechnicalEngine') return true;
  const d = unwrapTechPayload(p);
  return d != null && typeof d.rsi === 'number' && Number.isFinite(d.rsi);
}

export function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function bollingerWidthPct(d: Record<string, unknown> | null): number | null {
  if (!d) return null;
  const upper = finiteNum(d.bbUpper);
  const lower = finiteNum(d.bbLower);
  const px = finiteNum(d.currentPrice);
  if (upper == null || lower == null || px == null || px === 0) return null;
  return ((upper - lower) / px) * 100;
}
