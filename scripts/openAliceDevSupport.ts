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
 * Real bug found and fixed (2026-08-18), corrected same day: `mcpEndpointAccepting()` only
 * proves an MCP server is listening at all, so `startOpenAliceGuardian()` used to defer to
 * whatever answered :47332 without checking it was really OpenAlice. The first fix checked
 * `tools/list` for `issue_create`/`inbox_read` - but reading OpenAlice's own source
 * (src/main.ts:113-130, src/server/mcp.ts:29-35) showed those tools are registered ONLY on the
 * per-workspace MCP path (`/mcp/:wsId`); the bare `/mcp` URL this launcher probes always serves
 * the global tool catalog (market/economy/UTA-shaped tools), regardless of OPENALICE_LITE_MODE -
 * which only disables the trading carrier's ability to execute, not tool registration. So that
 * check could never pass here and would flag every healthy Guardian boot as "wrong MCP".
 *
 * The launcher's actual job is narrower than app-level Guardian verification: confirm this is
 * genuinely an OpenAlice MCP server (not an unrelated process squatting the port), not which
 * mode it's running in. OpenAlice's McpServer always identifies itself as `open-alice` in the
 * MCP `initialize` handshake's `serverInfo.name` (src/server/mcp.ts:83) - that's a stable, real
 * identity signal `tools/list` isn't. Guardian-tool reachability (which does need a workspace) is
 * Argus's own OpenAliceAdapter/OpenAliceWorkspace's job at runtime, not this launcher's.
 *
 * Confirmed live (2026-08-18) that OpenAlice's Streamable HTTP transport answers `initialize`
 * with `content-type: text/event-stream` - the body is SSE-framed (`event: message\ndata: {...}`),
 * not plain JSON - so a bare `res.json()` throws, gets swallowed, and always reports "unknown".
 * `parseInitializeBody()` below reads the raw text and accepts either framing.
 */
function parseInitializeBody(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const dataLine = raw.split('\n').map((l) => l.trim()).find((l) => l.startsWith('data:'));
    if (!dataLine) return null;
    try {
      return JSON.parse(dataLine.slice('data:'.length).trim());
    } catch {
      return null;
    }
  }
}

export async function mcpEndpointIsOpenAlice(mcpUrl: string, timeoutMs = 2500): Promise<{ ok: boolean; reason: string }> {
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
    if (!res.ok) return { ok: false, reason: `initialize HTTP ${res.status}` };
    const raw = await res.text();
    const body: any = parseInitializeBody(raw);
    const serverName = body?.result?.serverInfo?.name;
    if (serverName === 'open-alice') {
      return { ok: true, reason: `Connected. serverInfo.name=open-alice at ${mcpUrl}.` };
    }
    return {
      ok: false,
      reason: `Wrong server: an MCP server answered at ${mcpUrl} but identified itself as "${serverName ?? 'unknown'}", not open-alice.`,
    };
  } catch (e: any) {
    return { ok: false, reason: `initialize failed: ${e?.message ?? e}` };
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
