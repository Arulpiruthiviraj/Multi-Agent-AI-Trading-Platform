/**
 * Load config/runtimeEnvCatalog.json. Missing or malformed entries fail boot.
 * This file classifies .env keys; it does not enable Quant, LIVE, or OMS.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export const RUNTIME_ENV_CATEGORIES = [
  'BROKER',
  'MARKET DATA',
  'AI',
  'QUANT',
  'MULTI-ASSET',
  'OPPORTUNITY DISCOVERY',
  'PORTFOLIO INTELLIGENCE',
  'ECOSYSTEM',
  'LOCAL AI',
  'ALERTING',
  'ADVANCED',
] as const;

export type RuntimeEnvCategory = (typeof RUNTIME_ENV_CATEGORIES)[number];
export type RuntimeEnvType = 'boolean' | 'number' | 'string';
export type RuntimeApplyMode =
  | 'HOT_RELOAD'
  | 'RESTART_REQUIRED'
  | 'RECONNECT_REQUIRED'
  | 'BOOT_ONLY'
  | 'SAFETY_CRITICAL';

export interface RuntimeEnvCatalogEntry {
  key: string;
  category: RuntimeEnvCategory;
  label: string;
  type: RuntimeEnvType;
  default: string;
  overridable: boolean;
  secret: boolean;
  safetyLocked: boolean;
  applyMode: RuntimeApplyMode;
  description: string;
}

export interface RuntimeEnvCatalogFile {
  resetAllConfirmation: string;
  entries: RuntimeEnvCatalogEntry[];
}

const APPLY_MODES: RuntimeApplyMode[] = [
  'HOT_RELOAD',
  'RESTART_REQUIRED',
  'RECONNECT_REQUIRED',
  'BOOT_ONLY',
  'SAFETY_CRITICAL',
];

function loadCatalog(): RuntimeEnvCatalogFile {
  const raw = loadRepoConfigJson<Record<string, unknown>>('runtimeEnvCatalog.json');
  if (typeof raw.resetAllConfirmation !== 'string' || !raw.resetAllConfirmation) {
    throw new Error('config/runtimeEnvCatalog.json missing resetAllConfirmation');
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new Error('config/runtimeEnvCatalog.json missing entries[]');
  }
  const seen = new Set<string>();
  const entries: RuntimeEnvCatalogEntry[] = [];
  for (const item of raw.entries) {
    if (!item || typeof item !== 'object') {
      throw new Error('config/runtimeEnvCatalog.json entries[] item is not an object');
    }
    const row = item as Record<string, unknown>;
    if (typeof row.key !== 'string' || !row.key) throw new Error('runtimeEnvCatalog entry missing key');
    if (seen.has(row.key)) throw new Error(`runtimeEnvCatalog duplicate key ${row.key}`);
    seen.add(row.key);
    if (!(RUNTIME_ENV_CATEGORIES as readonly string[]).includes(String(row.category))) {
      throw new Error(`runtimeEnvCatalog ${row.key} has unknown category`);
    }
    if (row.type !== 'boolean' && row.type !== 'number' && row.type !== 'string') {
      throw new Error(`runtimeEnvCatalog ${row.key} has unknown type`);
    }
    if (typeof row.default !== 'string') throw new Error(`runtimeEnvCatalog ${row.key} default must be a string`);
    if (typeof row.overridable !== 'boolean') throw new Error(`runtimeEnvCatalog ${row.key} overridable must be boolean`);
    if (typeof row.secret !== 'boolean') throw new Error(`runtimeEnvCatalog ${row.key} secret must be boolean`);
    if (typeof row.safetyLocked !== 'boolean') throw new Error(`runtimeEnvCatalog ${row.key} safetyLocked must be boolean`);
    if (!APPLY_MODES.includes(row.applyMode as RuntimeApplyMode)) {
      throw new Error(`runtimeEnvCatalog ${row.key} has unknown applyMode`);
    }
    if (typeof row.label !== 'string' || !row.label) throw new Error(`runtimeEnvCatalog ${row.key} missing label`);
    if (typeof row.description !== 'string' || !row.description) throw new Error(`runtimeEnvCatalog ${row.key} missing description`);
    if ((row.secret || row.safetyLocked) && row.overridable) {
      throw new Error(`runtimeEnvCatalog ${row.key} secret/safetyLocked keys cannot be overridable`);
    }
    entries.push({
      key: row.key,
      category: row.category as RuntimeEnvCategory,
      label: row.label,
      type: row.type,
      default: row.default,
      overridable: row.overridable,
      secret: row.secret,
      safetyLocked: row.safetyLocked,
      applyMode: row.applyMode as RuntimeApplyMode,
      description: row.description,
    });
  }
  return { resetAllConfirmation: raw.resetAllConfirmation, entries };
}

export const runtimeEnvCatalog: RuntimeEnvCatalogFile = loadCatalog();

export function runtimeEnvEntry(key: string): RuntimeEnvCatalogEntry | undefined {
  return runtimeEnvCatalog.entries.find((e) => e.key === key);
}

export function overridableRuntimeEnvKeys(): string[] {
  return runtimeEnvCatalog.entries.filter((e) => e.overridable).map((e) => e.key);
}
