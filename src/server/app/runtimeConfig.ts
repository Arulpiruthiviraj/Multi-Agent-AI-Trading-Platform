/**
 * Runtime presentation-adapter flags. Headless disables browser/Vite layers only —
 * never a separate trading engine.
 */

/** True when ARGUS_HEADLESS=true — skip Vite/static SPA; API may still run. */
export function isArgusHeadless(): boolean {
  return process.env.ARGUS_HEADLESS === 'true';
}

/** False when headless or WEB_UI_ENABLED=false. */
export function isWebUiEnabled(): boolean {
  if (isArgusHeadless()) return false;
  return process.env.WEB_UI_ENABLED !== 'false';
}

/** API adapter defaults on unless explicitly disabled. */
export function isApiEnabled(): boolean {
  return process.env.API_ENABLED !== 'false';
}
