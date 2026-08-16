/**
 * News cluster matching for RiskEngine news_veto.
 * impactScore on news_clusters is 0–1 from NewsImpactEngine; the veto threshold
 * in tradingSafety.json is 0–100. Symbols are JSON arrays stored as text.
 */

export function newsImpactOnVetoScale(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 1) return raw * 100;
  return raw;
}

export function clusterCoversSymbol(symbolsField: unknown, symbol: string): boolean {
  if (!symbol || typeof symbol !== 'string') return false;
  let arr: unknown[] = [];
  if (Array.isArray(symbolsField)) {
    arr = symbolsField;
  } else if (typeof symbolsField === 'string') {
    const trimmed = symbolsField.trim();
    if (!trimmed) return false;
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return false;
      arr = parsed;
    } catch {
      return false;
    }
  } else {
    return false;
  }
  return arr.some((s) => s === symbol);
}
