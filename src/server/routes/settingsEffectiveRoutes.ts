/**
 * Dual-config Settings API. Does not place orders, arm LIVE, or write .env.
 */
import { Router } from 'express';
import { tradingLimiter } from '../core/RateLimiters';
import {
  exportEffectiveRuntimeConfigRedacted,
  hydrateRuntimeConfigFromDb,
  listEffectiveRuntimeSettings,
  resetAllRuntimeOverrides,
  resetRuntimeOverride,
  resolveRuntimeSetting,
  setRuntimeOverride,
} from '../config/effectiveRuntimeConfig';
import { runtimeEnvCatalog } from '../config/runtimeEnvCatalog';

export const settingsEffectiveRouter = Router();

settingsEffectiveRouter.get('/effective', async (_req, res) => {
  try {
    await hydrateRuntimeConfigFromDb();
    res.json({
      ok: true,
      resetAllConfirmation: runtimeEnvCatalog.resetAllConfirmation,
      settings: listEffectiveRuntimeSettings(),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

settingsEffectiveRouter.get('/effective/export', async (_req, res) => {
  try {
    await hydrateRuntimeConfigFromDb();
    res.json({ ok: true, ...exportEffectiveRuntimeConfigRedacted() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

settingsEffectiveRouter.get('/effective/:key', async (req, res) => {
  try {
    await hydrateRuntimeConfigFromDb();
    const row = resolveRuntimeSetting(String(req.params.key || '').toUpperCase());
    if (!row) return res.status(404).json({ ok: false, error: 'Unknown setting' });
    res.json({ ok: true, ...row });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

settingsEffectiveRouter.post('/overrides', tradingLimiter, async (req, res) => {
  try {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim().toUpperCase() : '';
    const result = await setRuntimeOverride(key, req.body?.value, typeof req.body?.operator === 'string' ? req.body.operator : 'operator');
    if (result.ok === false) return res.status(result.status).json({ ok: false, error: result.error });
    res.json({
      ok: true,
      ...result.resolved,
      note: 'Override stored in config_overrides. .env was not modified. Safety-locked keys cannot be set this way.',
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

settingsEffectiveRouter.post('/overrides/:key/reset', tradingLimiter, async (req, res) => {
  try {
    const key = String(req.params.key || '').toUpperCase();
    const result = await resetRuntimeOverride(key, typeof req.body?.operator === 'string' ? req.body.operator : 'operator');
    if (result.ok === false) return res.status(result.status).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result.resolved, note: 'Database override removed. Effective value is now .env or the safe default.' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

settingsEffectiveRouter.post('/overrides/reset-all', tradingLimiter, async (req, res) => {
  try {
    const confirmation = typeof req.body?.confirm === 'string' ? req.body.confirm : '';
    const result = await resetAllRuntimeOverrides(confirmation, typeof req.body?.operator === 'string' ? req.body.operator : 'operator');
    if (result.ok === false) return res.status(result.status).json({ ok: false, error: result.error });
    res.json({
      ok: true,
      cleared: result.cleared,
      note: 'Only config_overrides rows were deleted. trades, fills, portfolio, risk, audit, and broker credentials were not touched. .env was not modified.',
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
