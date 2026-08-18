/**
 * ==========================================================
 * Module: OpenAliceWorkspace
 *
 * Purpose:
 * Resolves (or creates) the one OpenAlice workspace Argus uses to reach Guardian's
 * workspace-scoped MCP tools. Confirmed by reading OpenAlice's own source
 * (src/main.ts:113-130, src/server/mcp.ts:29-35): `issue_create` and `inbox_read` are
 * registered only on `workspaceToolCenter`, which the MCP server exposes at `/mcp/:wsId`.
 * The bare `/mcp` URL always serves the global `toolCenter` catalog (market/economy/UTA-shaped
 * tools) instead - regardless of OPENALICE_LITE_MODE, which only disables the trading carrier's
 * ability to execute, not which tools get registered.
 *
 * The workspace list/create REST API lives on OpenAlice's web plugin port (47331 by default -
 * GUARDIAN_WEB_PORT in scripts/openAliceDevSupport.ts), not the MCP port (47332). A loopback
 * request from Argus's own backend to that port passes OpenAlice's auth middleware's
 * localhost-trust bypass (src/webui/middleware/auth.ts) - no OpenAlice session/token needed.
 * ==========================================================
 */

const DEFAULT_WORKSPACE_TAG = 'argus-core';

let cachedWorkspaceId: string | null = null;
let cachedWorkspaceIdPromise: Promise<string | null> | null = null;

function webBaseUrlFromEnv(): string {
  return (process.env.OPENALICE_WEB_URL || 'http://127.0.0.1:47331').replace(/\/$/, '');
}

async function listWorkspaceId(webBaseUrl: string, tag: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(`${webBaseUrl}/api/workspaces`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body: any = await res.json().catch(() => null);
    const match = Array.isArray(body?.workspaces) ? body.workspaces.find((w: any) => w?.tag === tag) : null;
    return typeof match?.id === 'string' ? match.id : null;
  } catch {
    return null;
  }
}

async function findOrCreateWorkspace(webBaseUrl: string, tag: string, timeoutMs: number): Promise<string | null> {
  const existing = await listWorkspaceId(webBaseUrl, tag, timeoutMs);
  if (existing) return existing;

  try {
    const createRes = await fetch(`${webBaseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (createRes.status === 201) {
      const body: any = await createRes.json().catch(() => null);
      return typeof body?.workspace?.id === 'string' ? body.workspace.id : null;
    }
    if (createRes.status === 409) {
      // Another process created it between our list and create - one more read wins the race.
      return await listWorkspaceId(webBaseUrl, tag, timeoutMs);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves the Argus-Core workspace id once per process (cached; concurrent callers share the
 * in-flight lookup). Returns null - never throws - when the OpenAlice web port is unreachable or
 * creation fails; callers fall back to the bare (non-workspace) MCP URL, which stays an honest
 * "missing tools" health result rather than a crash.
 */
export async function ensureArgusWorkspaceId(timeoutMs = 5000): Promise<string | null> {
  if (cachedWorkspaceId) return cachedWorkspaceId;
  if (cachedWorkspaceIdPromise) return cachedWorkspaceIdPromise;

  cachedWorkspaceIdPromise = findOrCreateWorkspace(webBaseUrlFromEnv(), DEFAULT_WORKSPACE_TAG, timeoutMs)
    .then((id) => {
      if (id) {
        cachedWorkspaceId = id;
        console.log(`[OpenAliceAdapter] Bound to workspace Argus-Core (wsId: ${id})`);
      } else {
        console.warn(
          '[OpenAlice] Could not find or create the Argus-Core workspace via the OpenAlice web API ' +
          `(${webBaseUrlFromEnv()}/api/workspaces). Guardian tools (issue_create/inbox_read) stay ` +
          'unreachable until a workspace exists.',
        );
      }
      return id;
    })
    .finally(() => {
      cachedWorkspaceIdPromise = null;
    });
  return cachedWorkspaceIdPromise;
}

/** Test-only: clears the module-level cache between test cases. */
export function _resetArgusWorkspaceCacheForTests(): void {
  cachedWorkspaceId = null;
  cachedWorkspaceIdPromise = null;
}
