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
 * Real bug found and fixed (2026-08-18): `mcpEndpointAccepting()` only proves an MCP server is
 * listening at all - OpenAlice's own UTA (Universal Trading Adapter, a DIFFERENT MCP inside the
 * same OpenAlice checkout, with placeOrder/getQuote/tradingCommit/etc.) answers the exact same
 * `initialize` handshake just as successfully as Guardian does. `startOpenAliceGuardian()` used
 * to call only `mcpEndpointAccepting()` to decide "Guardian is already up, don't start my own" -
 * if UTA (or any other MCP) happened to already be bound to :47332 for any reason, the launcher
 * would wrongly defer to it, never attempt its own correctly-configured
 * (OPENALICE_LITE_MODE=1/OPENALICE_MCP_ENABLED=1) instance, and leave Argus's own later
 * OpenAliceAdapter.healthCheck() to discover the mismatch after the fact - exactly the live
 * "Wrong MCP: this URL is a trading/broker server" failure this closes. Does a real `tools/list`
 * call and requires both `issue_create` and `inbox_read` - the same check
 * OpenAliceAdapter.healthCheck() already performs inside the running server - so the launcher and
 * the app agree on what "Guardian" means, checked at the one place that decides whether to defer.
 */
export async function mcpEndpointHasGuardianTools(mcpUrl: string, timeoutMs = 2500): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `tools/list HTTP ${res.status}` };
    const body: any = await res.json().catch(() => null);
    const tools: string[] = Array.isArray(body?.result?.tools)
      ? body.result.tools.map((t: any) => String(t?.name ?? ''))
      : [];
    const hasRequired = tools.includes('issue_create') && tools.includes('inbox_read');
    if (hasRequired) return { ok: true, reason: `Connected. ${tools.length} tool(s) available, including issue_create and inbox_read.` };
    return {
      ok: false,
      reason: `Wrong MCP: an MCP server answered at ${mcpUrl} but lacks issue_create/inbox_read (this is OpenAlice UTA or another trading MCP, not Guardian). Available: ${tools.join(', ') || 'none'}`,
    };
  } catch (e: any) {
    return { ok: false, reason: `tools/list failed: ${e?.message ?? e}` };
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
