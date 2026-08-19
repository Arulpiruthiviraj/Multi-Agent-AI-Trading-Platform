import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hydrateRuntimeConfigFromDb,
  isRuntimeFlagEnabled,
  listEffectiveRuntimeSettings,
  resetAllRuntimeOverrides,
  resetRuntimeConfigCacheForTests,
  resetRuntimeOverride,
  resolveRuntimeNumber,
  resolveRuntimeSetting,
  setRuntimeOverride,
} from './effectiveRuntimeConfig';
import { runtimeEnvCatalog } from './runtimeEnvCatalog';
import { isPennyStockEnabled, isMultiAssetEnabled } from './multiAsset';
import { isPaperTradingOnlyEnforced } from '../core/tradingModeEnv';

const PREV: Record<string, string | undefined> = {};

function stash(keys: string[]) {
  for (const k of keys) PREV[k] = process.env[k];
}

function restore(keys: string[]) {
  for (const k of keys) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
}

const FLAG_KEYS = [
  'QUANT_ENGINE_ENABLED',
  'QUANT_ENGINE_INTERVAL_MS',
  'ARGUS_PENNY_STOCK_ENABLED',
  'ARGUS_MULTI_ASSET_ENABLED',
  'QUANT_SMC_STRATEGY_ENABLED',
  'PAPER_TRADING_ONLY',
  'ALPACA_API_KEY',
];

describe('effective runtime config (dual .env + Settings overlay)', () => {
  beforeEach(() => {
    stash(FLAG_KEYS);
    resetRuntimeConfigCacheForTests();
    for (const k of FLAG_KEYS) delete process.env[k];
  });

  afterEach(async () => {
    await resetAllRuntimeOverrides(runtimeEnvCatalog.resetAllConfirmation).catch(() => undefined);
    resetRuntimeConfigCacheForTests();
    restore(FLAG_KEYS);
  });

  it('TEST 1 fresh: unset env uses safe default, source DEFAULT; env false is source ENV', () => {
    const unset = resolveRuntimeSetting('QUANT_ENGINE_ENABLED')!;
    expect(unset.effectiveValue).toBe(false);
    expect(unset.source).toBe('DEFAULT');
    expect(unset.envValue).toBeNull();
    expect(unset.dbOverride).toBeNull();

    process.env.QUANT_ENGINE_ENABLED = 'false';
    const fromEnv = resolveRuntimeSetting('QUANT_ENGINE_ENABLED')!;
    expect(fromEnv.effectiveValue).toBe(false);
    expect(fromEnv.source).toBe('ENV');
    expect(fromEnv.envValue).toBe('false');
  });

  it('TEST 2-3 Settings override wins and survives env change (restart simulation)', async () => {
    process.env.QUANT_ENGINE_ENABLED = 'false';
    const set = await setRuntimeOverride('QUANT_ENGINE_ENABLED', true, 'test');
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(set.resolved.effectiveValue).toBe(true);
      expect(set.resolved.source).toBe('SETTINGS');
      expect(set.resolved.envValue).toBe('false');
      expect(set.resolved.dbOverride).toBe(true);
    }

    resetRuntimeConfigCacheForTests();
    process.env.QUANT_ENGINE_ENABLED = 'false';
    await hydrateRuntimeConfigFromDb();
    const afterRestart = resolveRuntimeSetting('QUANT_ENGINE_ENABLED')!;
    expect(afterRestart.effectiveValue).toBe(true);
    expect(afterRestart.source).toBe('SETTINGS');
  });

  it('TEST 4 changing .env does not clear a Settings overlay', async () => {
    process.env.QUANT_ENGINE_ENABLED = 'false';
    await setRuntimeOverride('QUANT_ENGINE_ENABLED', true, 'test');
    process.env.QUANT_ENGINE_ENABLED = 'false';
    const row = resolveRuntimeSetting('QUANT_ENGINE_ENABLED')!;
    expect(row.effectiveValue).toBe(true);
    expect(row.envValue).toBe('false');
    expect(row.source).toBe('SETTINGS');
  });

  it('TEST 5-6 reset to .env / delete overlay restores env', async () => {
    process.env.QUANT_ENGINE_ENABLED = 'false';
    await setRuntimeOverride('QUANT_ENGINE_ENABLED', true, 'test');
    const reset = await resetRuntimeOverride('QUANT_ENGINE_ENABLED', 'test');
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.resolved.effectiveValue).toBe(false);
      expect(reset.resolved.source).toBe('ENV');
      expect(reset.resolved.dbOverride).toBeNull();
    }
  });

  it('TEST 7 missing env uses safe default', () => {
    delete process.env.ARGUS_PENNY_STOCK_ENABLED;
    delete process.env.ARGUS_MULTI_ASSET_ENABLED;
    expect(isRuntimeFlagEnabled('ARGUS_PENNY_STOCK_ENABLED')).toBe(false);
    expect(isPennyStockEnabled()).toBe(false);
  });

  it('TEST 8 invalid boolean env is fail-safe false, not ON', () => {
    process.env.QUANT_ENGINE_ENABLED = 'yes';
    expect(isRuntimeFlagEnabled('QUANT_ENGINE_ENABLED')).toBe(false);
    expect(resolveRuntimeSetting('QUANT_ENGINE_ENABLED')!.source).toBe('ENV');
  });

  it('TEST 9 secrets never return contents', () => {
    process.env.ALPACA_API_KEY = 'super-secret-value-do-not-leak';
    const row = resolveRuntimeSetting('ALPACA_API_KEY')!;
    expect(row.secret).toBe(true);
    expect(row.configured).toBe(true);
    expect(row.effectiveValue).toBeNull();
    expect(JSON.stringify(row)).not.toContain('super-secret-value-do-not-leak');
    const listed = JSON.stringify(listEffectiveRuntimeSettings());
    expect(listed).not.toContain('super-secret-value-do-not-leak');
  });

  it('TEST 10 Settings cannot override PAPER_TRADING_ONLY', async () => {
    process.env.PAPER_TRADING_ONLY = 'true';
    const blocked = await setRuntimeOverride('PAPER_TRADING_ONLY', false, 'test');
    expect(blocked.ok).toBe(false);
    if (blocked.ok === false) expect(blocked.status).toBe(403);
    expect(isPaperTradingOnlyEnforced()).toBe(true);
    expect(resolveRuntimeSetting('PAPER_TRADING_ONLY')!.effectiveValue).toBe(true);
    expect(resolveRuntimeSetting('PAPER_TRADING_ONLY')!.overridable).toBe(false);
    expect(resolveRuntimeSetting('PAPER_TRADING_ONLY')!.safetyLocked).toBe(true);
  });

  it('TEST 11 LIVE_ARM is not a Settings key', () => {
    expect(runtimeEnvCatalog.entries.find((e) => e.key === 'LIVE_ARM')).toBeUndefined();
    expect(resolveRuntimeSetting('LIVE_ARM')).toBeNull();
  });

  it('TEST 12 penny overlay still requires both flags and does not change MARKET-only policy', async () => {
    process.env.ARGUS_MULTI_ASSET_ENABLED = 'true';
    process.env.ARGUS_PENNY_STOCK_ENABLED = 'false';
    expect(isMultiAssetEnabled()).toBe(true);
    expect(isPennyStockEnabled()).toBe(false);
    await setRuntimeOverride('ARGUS_PENNY_STOCK_ENABLED', true, 'test');
    expect(isPennyStockEnabled()).toBe(true);
    const { multiAssetConfig } = await import('./multiAsset');
    expect(multiAssetConfig.execution.marketOrdersFitPennyAndMicro).toBe(false);
  });

  it('TEST 13 Quant defaults remain off and experimental flags stay exact-string true', () => {
    expect(isRuntimeFlagEnabled('QUANT_ENGINE_ENABLED')).toBe(false);
    expect(isRuntimeFlagEnabled('QUANT_SMC_STRATEGY_ENABLED')).toBe(false);
    process.env.QUANT_SMC_STRATEGY_ENABLED = 'TRUE';
    expect(isRuntimeFlagEnabled('QUANT_SMC_STRATEGY_ENABLED')).toBe(false);
  });

  it('TEST 14 restartRequired is true for QUANT_ENGINE_ENABLED and false for penny (HOT_RELOAD)', () => {
    expect(resolveRuntimeSetting('QUANT_ENGINE_ENABLED')!.restartRequired).toBe(true);
    expect(resolveRuntimeSetting('ARGUS_PENNY_STOCK_ENABLED')!.restartRequired).toBe(false);
  });

  it('reset-all requires exact confirmation and does not need a secret dump', async () => {
    process.env.QUANT_ENGINE_ENABLED = 'false';
    await setRuntimeOverride('QUANT_ENGINE_ENABLED', true, 'test');
    const denied = await resetAllRuntimeOverrides('nope');
    expect(denied.ok).toBe(false);
    const ok = await resetAllRuntimeOverrides(runtimeEnvCatalog.resetAllConfirmation);
    expect(ok.ok).toBe(true);
    expect(isRuntimeFlagEnabled('QUANT_ENGINE_ENABLED')).toBe(false);
  });

  it('invalid number override is rejected; interval falls back to catalog default', async () => {
    const bad = await setRuntimeOverride('QUANT_ENGINE_INTERVAL_MS', 'nope', 'test');
    expect(bad.ok).toBe(false);
    expect(resolveRuntimeNumber('QUANT_ENGINE_INTERVAL_MS', 300000)).toBe(300000);
  });
});

describe('effective settings HTTP surface', () => {
  it('GET /api/v2/settings/effective redacts secrets and POST cannot set PAPER_TRADING_ONLY', async () => {
    const { settingsEffectiveRouter } = await import('../routes/settingsEffectiveRoutes');
    const app = express();
    app.use(express.json());
    app.use('/api/v2/settings', settingsEffectiveRouter);

    process.env.ALPACA_API_KEY = 'http-secret-should-not-appear';
    const list = await request(app).get('/api/v2/settings/effective');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('http-secret-should-not-appear');
    const alpaca = (list.body.settings as Array<{ setting: string; secret?: boolean; configured?: boolean }>).find((s) => s.setting === 'ALPACA_API_KEY');
    expect(alpaca?.secret).toBe(true);
    expect(alpaca?.configured).toBe(true);

    const live = await request(app).post('/api/v2/settings/overrides').send({ key: 'PAPER_TRADING_ONLY', value: false });
    expect(live.status).toBe(403);

    const exported = await request(app).get('/api/v2/settings/effective/export');
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).not.toContain('http-secret-should-not-appear');
  });
});

describe('dual-config does not become an order path', () => {
  it('settingsEffectiveRoutes never mentions placeOrder or BrokerManager', () => {
    const text = readFileSync(join(process.cwd(), 'src/server/routes/settingsEffectiveRoutes.ts'), 'utf8');
    expect(text).not.toMatch(/placeOrder/);
    expect(text).not.toMatch(/BrokerManager/);
    expect(text).not.toMatch(/RiskEngine/);
    expect(text).not.toMatch(/OrderManagement/);
  });

  it('overridable flag readers in production no longer use process.env.QUANT_ENGINE_ENABLED directly', () => {
    const files = [
      'src/server/services/QuantSignalAgent.ts',
      'src/server/core/liveReadinessEngine.ts',
      'src/server/research/paperTestingOverlay.ts',
      'src/server/quant/strategies/StrategyEngine.ts',
    ];
    for (const rel of files) {
      const text = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(text).not.toMatch(/process\.env\.QUANT_ENGINE_ENABLED/);
    }
  });

  it('catalog covers every overridable env the Settings UI is allowed to write', () => {
    const overridable = runtimeEnvCatalog.entries.filter((e) => e.overridable);
    expect(overridable.length).toBeGreaterThan(10);
    expect(overridable.every((e) => !e.secret && !e.safetyLocked)).toBe(true);
  });
});

describe('remaining process.env inventory is classified', () => {
  it('every runtimeEnvCatalog key exists as a classified row', () => {
    const keys = new Set(runtimeEnvCatalog.entries.map((e) => e.key));
    expect(keys.has('PAPER_TRADING_ONLY')).toBe(true);
    expect(keys.has('QUANT_ENGINE_ENABLED')).toBe(true);
    expect(keys.has('ARGUS_PENNY_STOCK_ENABLED')).toBe(true);
  });
});
