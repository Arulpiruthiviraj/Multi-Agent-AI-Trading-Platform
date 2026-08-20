/**
 * Runtime presentation-adapter flags. Headless/engine disables browser/Vite layers only —
 * never a separate trading engine.
 */

/** True when ARGUS_HEADLESS=true — skip Vite/static SPA; API may still run. */
export function isArgusHeadless(): boolean {
  return process.env.ARGUS_HEADLESS === 'true';
}

/**
 * Dedicated engine-daemon process (`scripts/argus-engine.ts`).
 * Implies headless presentation; same Argus Core as browser mode.
 */
export function isArgusEngineDaemon(): boolean {
  return process.env.ARGUS_ENGINE === 'true' || isArgusHeadless();
}

/** False when headless/engine or WEB_UI_ENABLED=false. */
export function isWebUiEnabled(): boolean {
  if (isArgusHeadless() || process.env.ARGUS_ENGINE === 'true') return false;
  return process.env.WEB_UI_ENABLED !== 'false';
}

/** HTTP adapter defaults on unless explicitly disabled. Engine CLI requires this. */
export function isApiEnabled(): boolean {
  return process.env.API_ENABLED !== 'false';
}

/** WebSocket EventBus fan-out adapter. Optional; default on. Not required for trading. */
export function isWebSocketAdapterEnabled(): boolean {
  if (!isApiEnabled()) return false;
  return process.env.WS_ENABLED !== 'false';
}
