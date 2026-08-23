/**
 * Load config/strategyFocus.json. Missing keys fail boot.
 * Adaptive mode = evaluate all CORE strategies, boost regime-preferred IDs, desk-rank, emit best.
 * Manual modes filter to listed strategy IDs only (discretionary override).
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import type { RegimeLabel, VolatilityLabel } from '../quant/RegimeEngine';

export type StrategyFocusKind = 'adaptive' | 'manual';

export interface StrategyFocusMode {
  id: string;
  label: string;
  kind: StrategyFocusKind;
  strategyIds: string[];
}

export interface StrategyFocusConfig {
  defaultFocus: string;
  modes: StrategyFocusMode[];
  legacyAliases: Record<string, string>;
  adaptivePreferredBoost: number;
  adaptiveNonPreferredScale: number;
  adaptiveRegimePreferredStrategies: Record<string, string[]>;
  adaptiveHighVolatilityPreferredStrategies: string[];
}

function requirePositiveNumber(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`config/strategyFocus.json ${label} must be a positive finite number`);
  }
  return raw;
}

function requireIdMap(raw: unknown, label: string): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`config/strategyFocus.json missing ${label}`);
  }
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s)) {
      throw new Error(`config/strategyFocus.json ${label}.${k} must be string[]`);
    }
    out[k] = (v as string[]).map((s) => s.trim().toUpperCase());
  }
  return out;
}

function loadStrategyFocus(): StrategyFocusConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('strategyFocus.json');
  if (typeof raw.defaultFocus !== 'string' || !raw.defaultFocus) {
    throw new Error('config/strategyFocus.json missing defaultFocus');
  }
  if (!Array.isArray(raw.modes) || raw.modes.length === 0) {
    throw new Error('config/strategyFocus.json modes must be a non-empty array');
  }
  const modes: StrategyFocusMode[] = raw.modes.map((m: any, i: number) => {
    if (!m || typeof m.id !== 'string' || !m.id) {
      throw new Error(`config/strategyFocus.json modes[${i}] missing id`);
    }
    if (typeof m.label !== 'string' || !m.label) {
      throw new Error(`config/strategyFocus.json modes[${i}] missing label`);
    }
    if (m.kind !== 'adaptive' && m.kind !== 'manual') {
      throw new Error(`config/strategyFocus.json modes[${i}] kind must be adaptive|manual`);
    }
    if (!Array.isArray(m.strategyIds) || m.strategyIds.some((s: unknown) => typeof s !== 'string')) {
      throw new Error(`config/strategyFocus.json modes[${i}] strategyIds must be string[]`);
    }
    return {
      id: m.id,
      label: m.label,
      kind: m.kind,
      strategyIds: (m.strategyIds as string[]).map((s) => s.trim().toUpperCase()),
    };
  });
  if (!modes.some((m) => m.id === raw.defaultFocus)) {
    throw new Error('config/strategyFocus.json defaultFocus must match a modes[].id');
  }
  const legacyAliases: Record<string, string> = {};
  if (raw.legacyAliases && typeof raw.legacyAliases === 'object') {
    for (const [k, v] of Object.entries(raw.legacyAliases as Record<string, unknown>)) {
      if (typeof v === 'string' && v) legacyAliases[k] = v;
    }
  }
  const highVol = raw.adaptiveHighVolatilityPreferredStrategies;
  if (!Array.isArray(highVol) || highVol.some((s) => typeof s !== 'string' || !s)) {
    throw new Error('config/strategyFocus.json adaptiveHighVolatilityPreferredStrategies must be string[]');
  }
  return {
    defaultFocus: raw.defaultFocus as string,
    modes,
    legacyAliases,
    adaptivePreferredBoost: requirePositiveNumber(raw.adaptivePreferredBoost, 'adaptivePreferredBoost'),
    adaptiveNonPreferredScale: requirePositiveNumber(raw.adaptiveNonPreferredScale, 'adaptiveNonPreferredScale'),
    adaptiveRegimePreferredStrategies: requireIdMap(raw.adaptiveRegimePreferredStrategies, 'adaptiveRegimePreferredStrategies'),
    adaptiveHighVolatilityPreferredStrategies: highVol.map((s) => String(s).trim().toUpperCase()),
  };
}

export const strategyFocusConfig: StrategyFocusConfig = loadStrategyFocus();

export function getStrategyFocusMode(idOrLabel: string | null | undefined): StrategyFocusMode {
  const raw = String(idOrLabel || '').trim();
  if (!raw) {
    return strategyFocusConfig.modes.find((m) => m.id === strategyFocusConfig.defaultFocus)!;
  }
  const aliased = strategyFocusConfig.legacyAliases[raw] || raw;
  const byId = strategyFocusConfig.modes.find((m) => m.id === aliased);
  if (byId) return byId;
  const byLabel = strategyFocusConfig.modes.find((m) => m.label === raw);
  if (byLabel) return byLabel;
  return strategyFocusConfig.modes.find((m) => m.id === strategyFocusConfig.defaultFocus)!;
}

/** Canonical id stored in settings.strategy / TradingEngine.state.strategy. */
export function normalizeStrategyFocus(idOrLabel: string | null | undefined): string {
  return getStrategyFocusMode(idOrLabel).id;
}

/**
 * Adaptive: pass-through (all CORE evaluations stay eligible for regime ranking).
 * Manual: keep only listed strategy IDs. Empty filter result falls back to full set
 * so a misconfigured override never silently kills Quant.
 */
export function filterEvaluationsForStrategyFocus<T extends { strategy: string }>(
  evaluations: T[],
  focusIdOrLabel: string | null | undefined,
): T[] {
  const mode = getStrategyFocusMode(focusIdOrLabel);
  if (mode.kind === 'adaptive' || mode.strategyIds.length === 0) return evaluations;
  const allowed = new Set(mode.strategyIds);
  const filtered = evaluations.filter((e) => allowed.has(String(e.strategy).toUpperCase()));
  return filtered.length > 0 ? filtered : evaluations;
}

export function isAdaptiveStrategyFocus(focusIdOrLabel: string | null | undefined): boolean {
  return getStrategyFocusMode(focusIdOrLabel).kind === 'adaptive';
}

/** Preferred CORE strategy ids for the live RegimeEngine label (+ HIGH vol overlay). */
export function preferredStrategiesForRegime(
  regime: RegimeLabel,
  volatility: VolatilityLabel | null | undefined = null,
): string[] {
  if (volatility === 'HIGH') {
    return [...strategyFocusConfig.adaptiveHighVolatilityPreferredStrategies];
  }
  return [
    ...(strategyFocusConfig.adaptiveRegimePreferredStrategies[regime]
      ?? strategyFocusConfig.adaptiveRegimePreferredStrategies.SIDEWAYS_RANGE
      ?? []),
  ];
}

/**
 * Soft boost for regime-matched CORE strategies under Adaptive mode.
 * Does not zero off-regime setups (RiskEngine/ChiefTrader still decide).
 * @deprecated Prefer selectEvaluationsForAdaptiveRegime for Option-B hard routing.
 */
export function applyAdaptiveRegimePreference<T extends { strategy: string; setupScore: number }>(
  evaluations: T[],
  focusIdOrLabel: string | null | undefined,
  regime: RegimeLabel,
  volatility: VolatilityLabel | null | undefined = null,
): T[] {
  if (!isAdaptiveStrategyFocus(focusIdOrLabel)) return evaluations;
  const preferred = new Set(preferredStrategiesForRegime(regime, volatility));
  if (preferred.size === 0) return evaluations;
  const boost = strategyFocusConfig.adaptivePreferredBoost;
  const scale = strategyFocusConfig.adaptiveNonPreferredScale;
  return evaluations
    .map((e) => {
      const id = String(e.strategy).toUpperCase();
      const setupScore = Math.round(e.setupScore * (preferred.has(id) ? boost : scale) * 100) / 100;
      return { ...e, setupScore };
    })
    .sort((a, b) => b.setupScore - a.setupScore);
}

/**
 * Option B — per-ticker regime routing:
 * Keep only CORE strategies mapped to the live RegimeEngine label (and HIGH-vol overlay).
 * Confidence for preferred setups is scaled by adaptivePreferredBoost; off-map setups are
 * dropped from the emit path (not zeroed into a parallel sleeve). Falls back to soft-boost
 * of the full set if the preferred subset is empty so Quant never silently dies.
 */
export function selectEvaluationsForAdaptiveRegime<T extends { strategy: string; setupScore: number; confidence: number }>(
  evaluations: T[],
  focusIdOrLabel: string | null | undefined,
  regime: RegimeLabel,
  volatility: VolatilityLabel | null | undefined = null,
): T[] {
  if (!isAdaptiveStrategyFocus(focusIdOrLabel)) return evaluations;
  const preferred = preferredStrategiesForRegime(regime, volatility);
  if (preferred.length === 0) return evaluations;
  const preferredSet = new Set(preferred);
  const boost = strategyFocusConfig.adaptivePreferredBoost;
  const routed = evaluations
    .filter((e) => preferredSet.has(String(e.strategy).toUpperCase()))
    .map((e) => ({
      ...e,
      setupScore: Math.round(e.setupScore * boost * 100) / 100,
      confidence: Math.min(1, Math.round(e.confidence * boost * 1000) / 1000),
    }))
    .sort((a, b) => b.setupScore - a.setupScore);
  if (routed.length > 0) return routed;
  return applyAdaptiveRegimePreference(evaluations, focusIdOrLabel, regime, volatility);
}
