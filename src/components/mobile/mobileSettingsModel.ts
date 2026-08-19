export const RUNTIME_KEYS = {
  opportunity: 'ARGUS_OPPORTUNITY_LOOP_ENABLED',
  portfolioIntel: 'ARGUS_PORTFOLIO_INTEL_ENABLED',
  multiAsset: 'ARGUS_MULTI_ASSET_ENABLED',
  penny: 'ARGUS_PENNY_STOCK_ENABLED',
  quant: 'QUANT_ENGINE_ENABLED',
  paperOnly: 'PAPER_TRADING_ONLY',
} as const;

export type EffectiveRow = {
  setting: string;
  label: string;
  category: string;
  type: string;
  description: string;
  effectiveValue: string | boolean | number | null;
  envValue: string | null;
  dbOverride: string | boolean | number | null;
  source: 'SETTINGS' | 'ENV' | 'DEFAULT';
  overridable: boolean;
  safetyLocked: boolean;
  secret: boolean;
  applyMode: string;
  restartRequired: boolean;
  configured?: boolean;
};

export function findRow(rows: EffectiveRow[], key: string): EffectiveRow | undefined {
  return rows.find((r) => r.setting === key);
}

export function sourceBadge(source: EffectiveRow['source']): { label: string; className: string } {
  if (source === 'SETTINGS') return { label: 'DB Override', className: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40' };
  if (source === 'ENV') return { label: '.env Default', className: 'bg-slate-800 text-slate-400 border-slate-700' };
  return { label: 'Safe default', className: 'bg-slate-800 text-slate-500 border-slate-700' };
}

export function formatBool(v: unknown): string {
  if (v === true || v === 'true') return 'ON';
  if (v === false || v === 'false') return 'OFF';
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

export function formatEnvFallback(row: EffectiveRow): string {
  if (row.secret) return row.configured ? '(.env: Configured)' : '(.env: Missing)';
  const v = row.envValue;
  if (v === null || v === undefined || v === '') return '(.env: unset)';
  if (v === 'true') return '(.env: ON)';
  if (v === 'false') return '(.env: OFF)';
  return `(.env: ${v})`;
}

export function matchesSearch(
  row: Pick<EffectiveRow, 'setting' | 'label' | 'description' | 'category'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.setting, row.label, row.description, row.category]
    .some((s) => String(s || '').toLowerCase().includes(q));
}

export function isTruthyEffective(row: EffectiveRow | undefined): boolean {
  if (!row) return false;
  return row.effectiveValue === true || row.effectiveValue === 'true';
}

/** Optimistic DB overlay after a boolean toggle, before the GET round-trip. */
export function optimisticBoolOverride(row: EffectiveRow, next: boolean): EffectiveRow {
  return {
    ...row,
    effectiveValue: next,
    dbOverride: next,
    source: 'SETTINGS',
  };
}

/** Optimistic revert of a single DB overlay back to .env / catalog default. */
export function optimisticResetToEnv(row: EffectiveRow): EffectiveRow {
  const envOn = row.envValue === 'true';
  const envOff = row.envValue === 'false';
  const fromEnv = envOn || envOff;
  return {
    ...row,
    dbOverride: null,
    source: fromEnv ? 'ENV' : 'DEFAULT',
    effectiveValue: fromEnv ? envOn : row.effectiveValue,
  };
}

import tradingSafety from '../../../config/tradingSafety.json';

export const TAKE_PROFIT_STEPS = [5, 10, 15, 20, 25].filter(
  (n) => n >= tradingSafety.settingsBoundTakeProfitPctMin && n <= tradingSafety.settingsBoundTakeProfitPctMax,
);
export const COST_BASIS_STOP_STEPS = [3, 5, 8, 10].filter(
  (n) => n >= tradingSafety.settingsBoundTrailingStopPctMin && n <= tradingSafety.settingsBoundTrailingStopPctMax,
);

export const BROKER_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'Argus Internal Simulator', label: 'Internal Paper' },
  { value: 'Alpaca', label: 'Alpaca Paper' },
  { value: 'Interactive Brokers', label: 'IBKR' },
];

export const LLM_PRESELECTS = ['Gemini', 'Claude', 'OpenAI', 'Ollama (Local)'] as const;
