import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEALTH_VORTEX,
  LEGACY_KEY_AFFIRM,
  LEGACY_KEY_DIVINE,
  LEGACY_KEY_HYPER,
  WEALTH_VORTEX_KEY,
  loadWealthVortexSettings,
  migrateFromLegacy,
  parseWealthVortex,
  type StorageLike,
} from './wealthVortexStore';

function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(seed));
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

describe('wealthVortexStore', () => {
  it('migrates legacy priority divine > hyper > affirm', () => {
    expect(migrateFromLegacy({ affirm: true, hyper: true, divine: true })).toEqual({
      enabled: true,
      mode: 'divine_omnipresent',
      sound: false,
    });
    expect(migrateFromLegacy({ affirm: true, hyper: true, divine: false })).toEqual({
      enabled: true,
      mode: 'hyper_abundance_777',
      sound: false,
    });
    expect(migrateFromLegacy({ affirm: true, hyper: false, divine: false })).toEqual({
      enabled: true,
      mode: 'sacred_gold_flow',
      sound: false,
    });
    expect(migrateFromLegacy({ affirm: false, hyper: false, divine: false })).toEqual(
      DEFAULT_WEALTH_VORTEX,
    );
  });

  it('parses consolidated argus_wealth_vortex JSON', () => {
    expect(
      parseWealthVortex(
        JSON.stringify({ enabled: true, mode: 'hyper_abundance_777', sound: true }),
      ),
    ).toEqual({ enabled: true, mode: 'hyper_abundance_777', sound: true });
    expect(parseWealthVortex('not-json')).toBeNull();
    expect(parseWealthVortex(JSON.stringify({ enabled: 1, mode: 'nope' }))).toEqual({
      enabled: true,
      mode: 'sacred_gold_flow',
      sound: false,
    });
  });

  it('loads new key preferentially and still clears leftover legacy keys', () => {
    const storage = memoryStorage({
      [LEGACY_KEY_DIVINE]: 'true',
      [WEALTH_VORTEX_KEY]: JSON.stringify({
        enabled: true,
        mode: 'sacred_gold_flow',
        sound: true,
      }),
    });
    expect(loadWealthVortexSettings(storage)).toEqual({
      enabled: true,
      mode: 'sacred_gold_flow',
      sound: true,
    });
    expect(storage.getItem(LEGACY_KEY_DIVINE)).toBeNull();
  });

  it('migrates legacy once into argus_wealth_vortex and removes old keys', () => {
    const storage = memoryStorage({
      [LEGACY_KEY_AFFIRM]: 'true',
      [LEGACY_KEY_HYPER]: 'true',
      [LEGACY_KEY_DIVINE]: 'false',
    });
    expect(loadWealthVortexSettings(storage)).toEqual({
      enabled: true,
      mode: 'hyper_abundance_777',
      sound: false,
    });
    expect(JSON.parse(storage.getItem(WEALTH_VORTEX_KEY)!)).toEqual({
      enabled: true,
      mode: 'hyper_abundance_777',
      sound: false,
    });
    expect(storage.getItem(LEGACY_KEY_AFFIRM)).toBeNull();
    expect(storage.getItem(LEGACY_KEY_HYPER)).toBeNull();
    expect(storage.getItem(LEGACY_KEY_DIVINE)).toBeNull();
  });
});
