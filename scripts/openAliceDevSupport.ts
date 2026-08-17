/**
 * Shared OpenAlice Guardian helpers for `npm run dev` (ecosystem-dev) and `npm run dev:core`.
 * Does not vendor OpenAlice source. Research/verification only — never BrokerManager/RiskEngine.
 */

/** OpenAlice Guardian MCP (issue_create / inbox_read). Not the UTA trading MCP on 47333. */
export const GUARDIAN_MCP_PORT = 47332;
export const GUARDIAN_WEB_PORT = 47331;
export const GUARDIAN_MCP_URL = `http://127.0.0.1:${GUARDIAN_MCP_PORT}/mcp`;

function envFlag(name: string, env: NodeJS.ProcessEnv, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/**
 * Skip Guardian spawn when the operator asked not to start it.
 * ENABLE_OPENALICE defaults ON (unset/empty → start). ARGUS_SKIP_OPENALICE=true always skips.
 */
export function shouldSkipOpenAlice(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ARGUS_SKIP_OPENALICE === 'true') return true;
  return !envFlag('ENABLE_OPENALICE', env, true);
}

export function openAliceSkipReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ARGUS_SKIP_OPENALICE === 'true') {
    return 'ARGUS_SKIP_OPENALICE=true — not starting OpenAlice Guardian.';
  }
  if (!envFlag('ENABLE_OPENALICE', env, true)) {
    return 'ENABLE_OPENALICE=false — not starting OpenAlice Guardian.';
  }
  return null;
}

/** True when an HTTP server accepted a Streamable MCP initialize POST (any status). */
export async function mcpEndpointAccepting(mcpUrl: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'argus-dev-launcher', version: '0' },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return Number.isFinite(res.status) && res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Wait until Guardian MCP accepts a connection (not just TCP).
 * Alice `/api/version` coming up first is a good sign; MCP on :47332 is the Argus probe target.
 */
export async function waitForOpenAliceMcp(
  mcpUrl: string,
  timeoutMs: number,
  log: (msg: string) => void = console.warn,
  shouldAbort?: () => boolean,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (shouldAbort?.()) return false;
    if (await mcpEndpointAccepting(mcpUrl)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!shouldAbort?.()) {
    log(`[dev] Timed out waiting for OpenAlice Guardian MCP at ${mcpUrl} (${timeoutMs}ms).`);
  }
  return false;
}

export function openAliceHowToEnable(checkoutPath: string): string {
  return [
    `OpenAlice checkout expected at ${checkoutPath} (or set OPENALICE_PATH / OPENALICE_REPO_PATH).`,
    'Clone: git clone https://github.com/TraderAlice/OpenAlice.git into that folder.',
    'Needs pnpm (corepack enable && corepack prepare pnpm@11.7.0 --activate) and Node >= 22.19.',
    'Guardian MCP is http://127.0.0.1:47332/mcp (OPENALICE_MCP_ENABLED must be the string 1, not true).',
    'Skip spawn with ARGUS_SKIP_OPENALICE=true or ENABLE_OPENALICE=false.',
  ].join(' ');
}
