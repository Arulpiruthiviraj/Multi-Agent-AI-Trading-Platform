/**
 * Dual configuration resolver.
 *
 * Precedence for overridable non-secret keys:
 *   explicit DB override (in-memory cache hydrated from config_overrides)
 *     → process.env
 *     → catalog safe default
 *
 * Safety-locked / secret keys ignore DB overrides. LIVE_ARM, RiskEngine, OMS, and
 * PAPER_TRADING_ONLY stay on their existing paths.
 *
 * This module does not import `db` at load time so unit tests that only flip process.env
 * do not open data/argus.db. Hydrate/persist use a dynamic import.
 */
import { runtimeEnvCatalog, runtimeEnvEntry, type RuntimeEnvCatalogEntry } from './runtimeEnvCatalog';

export type ConfigSource = 'SETTINGS' | 'ENV' | 'DEFAULT';

export interface ResolvedRuntimeSetting {
  setting: string;
  label: string;
  category: string;
  type: string;
  description: string;
  effectiveValue: string | boolean | number | null;
  envValue: string | null;
  dbOverride: string | boolean | number | null;
  source: ConfigSource;
  overridable: boolean;
  safetyLocked: boolean;
  secret: boolean;
  applyMode: string;
  restartRequired: boolean;
  configured?: boolean;
}

const overrideCache = new Map<string, string>();

export function resetRuntimeConfigCacheForTests(): void {
  overrideCache.clear();
}

export function peekRuntimeOverrideForTests(key: string): string | undefined {
  return overrideCache.get(key);
}

export function seedRuntimeOverrideCacheForTests(key: string, value: string): void {
  overrideCache.set(key, value);
}

function rawEnv(key: string): string | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  return v;
}

function envIsSet(key: string): boolean {
  return rawEnv(key) !== undefined;
}

export function parseCatalogValue(entry: RuntimeEnvCatalogEntry, raw: string): string | boolean | number {
  if (entry.type === 'boolean') return raw === 'true';
  if (entry.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return Number(entry.default);
    return n;
  }
  return raw;
}

function canonicalString(entry: RuntimeEnvCatalogEntry, raw: unknown): string | null {
  if (entry.type === 'boolean') {
    if (raw === true || raw === 'true') return 'true';
    if (raw === false || raw === 'false') return 'false';
    return null;
  }
  if (entry.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return String(n);
  }
  if (typeof raw !== 'string') return null;
  return raw;
}

export function resolveRuntimeSetting(key: string): ResolvedRuntimeSetting | null {
  const entry = runtimeEnvEntry(key);
  if (!entry) return null;

  const envRaw = rawEnv(key);
  const envSet = envIsSet(key);
  const cached = entry.overridable && !entry.safetyLocked && !entry.secret ? overrideCache.get(key) : undefined;

  let source: ConfigSource = 'DEFAULT';
  let chosen = entry.default;
  if (envSet) {
    chosen = envRaw as string;
    source = 'ENV';
  }
  if (cached !== undefined) {
    chosen = cached;
    source = 'SETTINGS';
  }

  const restartRequired = entry.applyMode !== 'HOT_RELOAD';

  if (entry.secret) {
    const configured = !!(envRaw && envRaw.length > 0);
    return {
      setting: entry.key,
      label: entry.label,
      category: entry.category,
      type: entry.type,
      description: entry.description,
      effectiveValue: null,
      envValue: null,
      dbOverride: null,
      source: configured ? 'ENV' : 'DEFAULT',
      overridable: false,
      safetyLocked: true,
      secret: true,
      applyMode: entry.applyMode,
      restartRequired,
      configured,
    };
  }

  return {
    setting: entry.key,
    label: entry.label,
    category: entry.category,
    type: entry.type,
    description: entry.description,
    effectiveValue: parseCatalogValue(entry, chosen),
    envValue: envSet ? envRaw as string : null,
    dbOverride: cached !== undefined ? parseCatalogValue(entry, cached) : null,
    source,
    overridable: entry.overridable,
    safetyLocked: entry.safetyLocked,
    secret: false,
    applyMode: entry.applyMode,
    restartRequired,
  };
}

/** Same contract as historical `process.env[key] === 'true'`, plus optional Settings overlay. */
export function isRuntimeFlagEnabled(key: string): boolean {
  const resolved = resolveRuntimeSetting(key);
  if (!resolved || resolved.secret) return process.env[key] === 'true';
  return resolved.effectiveValue === true;
}

export function resolveRuntimeNumber(key: string, fallback: number): number {
  const resolved = resolveRuntimeSetting(key);
  if (!resolved || typeof resolved.effectiveValue !== 'number' || !Number.isFinite(resolved.effectiveValue) || resolved.effectiveValue <= 0) {
    return fallback;
  }
  return resolved.effectiveValue;
}

export function listEffectiveRuntimeSettings(): ResolvedRuntimeSetting[] {
  return runtimeEnvCatalog.entries.map((e) => resolveRuntimeSetting(e.key)!);
}

export async function hydrateRuntimeConfigFromDb(): Promise<number> {
  try {
    const { db } = await import('../db');
    const { configOverrides } = await import('../db/schema');
    const rows = await db.select().from(configOverrides);
    overrideCache.clear();
    for (const row of rows) {
      const entry = runtimeEnvEntry(row.key);
      if (!entry || !entry.overridable || entry.secret || entry.safetyLocked) continue;
      overrideCache.set(row.key, row.value);
    }
    return overrideCache.size;
  } catch (e) {
    console.warn('[EffectiveRuntimeConfig] hydrate skipped:', e instanceof Error ? e.message : e);
    return 0;
  }
}

async function persistAudit(row: {
  setting: string;
  oldEffective: string | null;
  newValue: string | null;
  source: string;
  operator: string;
  restartRequired: boolean;
}): Promise<void> {
  const { db } = await import('../db');
  const { configChangeEvents } = await import('../db/schema');
  await db.insert(configChangeEvents).values({
    setting: row.setting,
    oldEffective: row.oldEffective,
    newValue: row.newValue,
    source: row.source,
    operator: row.operator,
    restartRequired: row.restartRequired,
    createdAt: new Date().toISOString(),
  });
}

export async function setRuntimeOverride(
  key: string,
  rawValue: unknown,
  operator = 'operator',
): Promise<{ ok: true; resolved: ResolvedRuntimeSetting } | { ok: false; error: string; status: number }> {
  const entry = runtimeEnvEntry(key);
  if (!entry) return { ok: false, error: `Unknown setting ${key}`, status: 404 };
  if (entry.secret) return { ok: false, error: 'Secrets cannot be stored in Settings overrides.', status: 403 };
  if (entry.safetyLocked || !entry.overridable) {
    return { ok: false, error: `${key} is not Settings-overridable (safety/boot lock).`, status: 403 };
  }
  const canonical = canonicalString(entry, rawValue);
  if (canonical === null) {
    return { ok: false, error: `Invalid value for ${key} (expected ${entry.type}).`, status: 400 };
  }
  const before = resolveRuntimeSetting(key);
  const { db } = await import('../db');
  const { configOverrides } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const existing = await db.select().from(configOverrides).where(eq(configOverrides.key, key)).limit(1);
  const now = new Date().toISOString();
  if (existing.length > 0) {
    await db.update(configOverrides).set({ value: canonical, updatedAt: now, updatedBy: operator }).where(eq(configOverrides.key, key));
  } else {
    await db.insert(configOverrides).values({ key, value: canonical, updatedAt: now, updatedBy: operator });
  }
  overrideCache.set(key, canonical);
  await persistAudit({
    setting: key,
    oldEffective: before ? String(before.effectiveValue) : null,
    newValue: canonical,
    source: 'SETTINGS',
    operator,
    restartRequired: entry.applyMode !== 'HOT_RELOAD',
  });
  return { ok: true, resolved: resolveRuntimeSetting(key)! };
}

export async function resetRuntimeOverride(
  key: string,
  operator = 'operator',
): Promise<{ ok: true; resolved: ResolvedRuntimeSetting } | { ok: false; error: string; status: number }> {
  const entry = runtimeEnvEntry(key);
  if (!entry) return { ok: false, error: `Unknown setting ${key}`, status: 404 };
  if (!entry.overridable) return { ok: false, error: `${key} has no Settings override to reset.`, status: 403 };
  const before = resolveRuntimeSetting(key);
  const { db } = await import('../db');
  const { configOverrides } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  await db.delete(configOverrides).where(eq(configOverrides.key, key));
  overrideCache.delete(key);
  await persistAudit({
    setting: key,
    oldEffective: before ? String(before.effectiveValue) : null,
    newValue: null,
    source: 'RESET_ENV',
    operator,
    restartRequired: entry.applyMode !== 'HOT_RELOAD',
  });
  return { ok: true, resolved: resolveRuntimeSetting(key)! };
}

export async function resetAllRuntimeOverrides(
  confirmation: string,
  operator = 'operator',
): Promise<{ ok: true; cleared: number } | { ok: false; error: string; status: number }> {
  if (confirmation !== runtimeEnvCatalog.resetAllConfirmation) {
    return { ok: false, error: `Confirmation must be exactly ${runtimeEnvCatalog.resetAllConfirmation}`, status: 400 };
  }
  const keys = [...overrideCache.keys()];
  const { db } = await import('../db');
  const { configOverrides } = await import('../db/schema');
  await db.delete(configOverrides);
  overrideCache.clear();
  for (const key of keys) {
    const entry = runtimeEnvEntry(key);
    await persistAudit({
      setting: key,
      oldEffective: null,
      newValue: null,
      source: 'RESET_ALL',
      operator,
      restartRequired: entry ? entry.applyMode !== 'HOT_RELOAD' : true,
    });
  }
  return { ok: true, cleared: keys.length };
}

export function exportEffectiveRuntimeConfigRedacted(): {
  generatedAt: string;
  honesty: string;
  settings: Array<Record<string, unknown>>;
} {
  return {
    generatedAt: new Date().toISOString(),
    honesty: 'Secrets redacted. This export does not write .env. PAPER_TRADING_ONLY and LIVE_ARM are not bypassed by Settings.',
    settings: listEffectiveRuntimeSettings().map((row) => {
      if (row.secret) {
        return {
          setting: row.setting,
          configured: row.configured === true ? 'CONFIGURED' : 'MISSING',
          source: row.source,
          secret: true,
          safetyLocked: true,
        };
      }
      return {
        setting: row.setting,
        effectiveValue: row.effectiveValue,
        envValue: row.envValue,
        dbOverride: row.dbOverride,
        source: row.source,
        applyMode: row.applyMode,
        restartRequired: row.restartRequired,
        safetyLocked: row.safetyLocked,
      };
    }),
  };
}
