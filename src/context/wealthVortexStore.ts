/**
 * Browser-only wealth-vortex preference store.
 * Theater/visual settings only — never sent to backend; never touches RiskEngine / OMS / brokers.
 */

export const WEALTH_VORTEX_KEY = 'argus_wealth_vortex';

/** Legacy per-toggle keys (read once, then removed). */
export const LEGACY_KEY_AFFIRM = 'argus_enable_wealth_affirmations';
export const LEGACY_KEY_HYPER = 'argus_enable_hyper_abundance_mode';
export const LEGACY_KEY_DIVINE = 'argus_enable_divine_wealth_mode';

export type WealthVortexMode =
  | 'sacred_gold_flow'
  | 'hyper_abundance_777'
  | 'divine_omnipresent';

export interface WealthVortexSettings {
  enabled: boolean;
  mode: WealthVortexMode;
  sound: boolean;
}

export const DEFAULT_WEALTH_VORTEX: WealthVortexSettings = {
  enabled: false,
  mode: 'sacred_gold_flow',
  sound: false,
};

const MODES: ReadonlySet<string> = new Set([
  'sacred_gold_flow',
  'hyper_abundance_777',
  'divine_omnipresent',
]);

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function readLegacyBool(storage: StorageLike, key: string): boolean {
  try {
    return storage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/** Map old three-toggle state → consolidated vortex settings (priority: divine > hyper > affirm). */
export function migrateFromLegacy(flags: {
  affirm: boolean;
  hyper: boolean;
  divine: boolean;
}): WealthVortexSettings {
  if (flags.divine) {
    return { enabled: true, mode: 'divine_omnipresent', sound: false };
  }
  if (flags.hyper) {
    return { enabled: true, mode: 'hyper_abundance_777', sound: false };
  }
  if (flags.affirm) {
    return { enabled: true, mode: 'sacred_gold_flow', sound: false };
  }
  return { ...DEFAULT_WEALTH_VORTEX };
}

export function parseWealthVortex(raw: string | null): WealthVortexSettings | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WealthVortexSettings>;
    if (typeof parsed !== 'object' || parsed == null) return null;
    const mode = typeof parsed.mode === 'string' && MODES.has(parsed.mode)
      ? (parsed.mode as WealthVortexMode)
      : DEFAULT_WEALTH_VORTEX.mode;
    return {
      enabled: Boolean(parsed.enabled),
      mode,
      sound: Boolean(parsed.sound),
    };
  } catch {
    return null;
  }
}

export function loadWealthVortexSettings(
  storage: StorageLike = typeof localStorage !== 'undefined' ? localStorage : createMemoryStorage(),
): WealthVortexSettings {
  try {
    const existing = parseWealthVortex(storage.getItem(WEALTH_VORTEX_KEY));
    if (existing) {
      clearLegacyKeys(storage);
      return existing;
    }

    const legacy = {
      affirm: readLegacyBool(storage, LEGACY_KEY_AFFIRM),
      hyper: readLegacyBool(storage, LEGACY_KEY_HYPER),
      divine: readLegacyBool(storage, LEGACY_KEY_DIVINE),
    };
    const migrated = migrateFromLegacy(legacy);
    saveWealthVortexSettings(migrated, storage);
    clearLegacyKeys(storage);
    return migrated;
  } catch {
    return { ...DEFAULT_WEALTH_VORTEX };
  }
}

export function saveWealthVortexSettings(
  settings: WealthVortexSettings,
  storage: StorageLike = typeof localStorage !== 'undefined' ? localStorage : createMemoryStorage(),
): void {
  try {
    storage.setItem(WEALTH_VORTEX_KEY, JSON.stringify(settings));
  } catch {
    /* private mode / quota */
  }
}

export function clearLegacyKeys(storage: StorageLike): void {
  try {
    storage.removeItem(LEGACY_KEY_AFFIRM);
    storage.removeItem(LEGACY_KEY_HYPER);
    storage.removeItem(LEGACY_KEY_DIVINE);
  } catch {
    /* ignore */
  }
}

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}
