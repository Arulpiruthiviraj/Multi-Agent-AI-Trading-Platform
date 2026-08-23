/**
 * Adaptive IBKR ecosystem health for CLI (`argus-ecosystem-status`) and UI
 * (`ModelRuntimeManager` / orchestration models card).
 *
 * Probe target follows the *active* broker — not a static Client Portal :5000 check.
 * Does not place orders; TCP/REST reachability only.
 */
import https from 'https';
import { findFirstOpenTcpPort, probeTcpPort } from '../../brokers/ibkrTcpProbe';
import { loadIbkrConnection, ibkrSocketPortCandidates } from '../config/ibkrConnection';
import { networkEndpoints } from '../config/networkEndpoints';

export type IbkrHealthProbeMode = 'socket' | 'web_api' | 'standby';

export type IbkrEcosystemHealthStatus = 'READY' | 'FAILED' | 'DISABLED' | 'STARTING' | 'STOPPED';

export interface IbkrEcosystemHealthResult {
  id: 'ibkr-gateway';
  health: IbkrEcosystemHealthStatus;
  /** Short label for CLI / UI primary line */
  detail: string;
  action: string | null;
  provider: string;
  endpoint: string;
  latencyMs: number | null;
  loaded: boolean;
  probeMode: IbkrHealthProbeMode;
  activeBrokerId: string | null;
}

export interface IbkrEcosystemHealthOptions {
  /** Broker id or display name (ibkr_gateway, alpaca, …). */
  activeBrokerIdOrName?: string | null;
  /** When true (argus.sh --mode stopped), prefer STOPPED over FAILED if nothing listens. */
  expectStopped?: boolean;
  /** Optional account id already known from an in-process socket session. */
  sessionAccountId?: string | null;
  /** Skip entirely (ARGUS_SKIP_IBKR=true). */
  skip?: boolean;
}

function normalizeBrokerKey(raw: string | null | undefined): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Map settings / BrokerManager id (or display name) → which IBKR probe to run.
 * Non-IBKR actives → standby (never FAILED for a dormant Gateway).
 */
export function resolveIbkrHealthProbeMode(
  activeBrokerIdOrName: string | null | undefined,
  connectionMode: 'socket' | 'web_api' = loadIbkrConnection().mode,
): IbkrHealthProbeMode {
  const key = normalizeBrokerKey(activeBrokerIdOrName);
  if (!key) {
    // No selection known — follow reviewed connection mode (socket is primary product path).
    return connectionMode === 'web_api' ? 'web_api' : 'socket';
  }
  if (
    key === 'ibkr_gateway' ||
    key === 'ibkr gateway (socket)' ||
    key === 'ib gateway' ||
    key === 'ib gateway (socket)'
  ) {
    return 'socket';
  }
  if (
    key === 'ibkr_web' ||
    key === 'ibkr web api' ||
    key === 'ibkr web api (client portal)' ||
    key === 'ibkr web'
  ) {
    return 'web_api';
  }
  // Legacy alias: honor connection mode (BrokerManager resolves gateway vs web at activate time).
  if (key === 'ibkr' || key === 'interactive brokers') {
    return connectionMode === 'web_api' ? 'web_api' : 'socket';
  }
  if (
    key === 'alpaca' ||
    key === 'internal_paper' ||
    key === 'simulation mode' ||
    key === 'coinbase' ||
    key === 'questrade'
  ) {
    return 'standby';
  }
  // Unknown display name that mentions IBKR → socket primary; else standby.
  if (key.includes('ibkr') || key.includes('interactive brokers') || key.includes('ib gateway')) {
    return connectionMode === 'web_api' ? 'web_api' : 'socket';
  }
  return 'standby';
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function probeIbkrClientPortalAuthStatus(
  baseUrl: string,
  timeoutMs: number,
): Promise<{
  reachable: boolean;
  latencyMs: number;
  authenticated?: boolean;
  error?: string;
}> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let url: URL;
    try {
      url = new URL(`${baseUrl.replace(/\/$/, '')}/iserver/auth/status`);
    } catch (e: any) {
      resolve({ reachable: false, latencyMs: 0, error: e.message });
      return;
    }
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        rejectUnauthorized: !isLocalHostname(url.hostname),
        timeout: timeoutMs,
        headers: { 'User-Agent': 'ArgusTradingPlatform/1.0' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          const latencyMs = Date.now() - t0;
          if (res.statusCode === 401) {
            resolve({ reachable: true, latencyMs, authenticated: false });
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            resolve({ reachable: false, latencyMs, error: `HTTP ${res.statusCode}` });
            return;
          }
          try {
            const body = JSON.parse(data || '{}');
            resolve({ reachable: true, latencyMs, authenticated: !!body.authenticated });
          } catch {
            resolve({ reachable: true, latencyMs, authenticated: false });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, latencyMs: Date.now() - t0, error: 'timeout' });
    });
    req.on('error', (e) =>
      resolve({ reachable: false, latencyMs: Date.now() - t0, error: e.message }),
    );
    req.end();
  });
}

function baseEntry(
  partial: Omit<IbkrEcosystemHealthResult, 'id'>,
): IbkrEcosystemHealthResult {
  return { id: 'ibkr-gateway', ...partial };
}

async function probeSocketMode(
  opts: IbkrEcosystemHealthOptions,
  activeBrokerId: string | null,
): Promise<IbkrEcosystemHealthResult> {
  const cfg = loadIbkrConnection();
  const host = cfg.host || '127.0.0.1';
  const ports = ibkrSocketPortCandidates(cfg, false);
  const t0 = Date.now();
  const openPort = await findFirstOpenTcpPort(host, ports, 1500);
  const latencyMs = Date.now() - t0;
  const preferred = cfg.preferredAccountId;
  const sessionAccount = opts.sessionAccountId?.trim() || null;

  if (openPort != null) {
    const label = `IB Gateway Socket Connected (Port ${openPort})`;
    let detail = label;
    if (sessionAccount) {
      detail = `${label}. Session active — Managed account ${sessionAccount} verified.`;
    } else if (preferred) {
      detail =
        `${label}. TCP accept OK — preferred account ${preferred} (config); ` +
        `session verifies when Argus ibkr_gateway authenticates.`;
    } else {
      detail = `${label}. TCP accept OK — no browser / Client Portal :5000 required.`;
    }
    return baseEntry({
      health: 'READY',
      detail,
      action: null,
      provider: 'Interactive Brokers Gateway (Socket)',
      endpoint: `tcp://${host}:${openPort}`,
      latencyMs,
      loaded: !!sessionAccount,
      probeMode: 'socket',
      activeBrokerId,
    });
  }

  if (opts.expectStopped) {
    return baseEntry({
      health: 'STOPPED',
      detail: 'IB Gateway Desktop socket not listening (expected after stop/nuke if Gateway was closed)',
      action: null,
      provider: 'Interactive Brokers Gateway (Socket)',
      endpoint: `tcp://${host}:${ports.join('/')}`,
      latencyMs,
      loaded: false,
      probeMode: 'socket',
      activeBrokerId,
    });
  }

  return baseEntry({
    health: 'FAILED',
    detail: `IB Gateway not detected on port ${ports.join('/')}`,
    action: 'IB Gateway not detected on port 4002/7497. Launch IB Gateway Desktop in Paper mode.',
    provider: 'Interactive Brokers Gateway (Socket)',
    endpoint: `tcp://${host}:${ports.join('/')}`,
    latencyMs,
    loaded: false,
    probeMode: 'socket',
    activeBrokerId,
  });
}

async function probeWebApiMode(
  opts: IbkrEcosystemHealthOptions,
  activeBrokerId: string | null,
): Promise<IbkrEcosystemHealthResult> {
  const cfg = loadIbkrConnection();
  const baseUrl =
    process.env.IBKR_GATEWAY_URL?.trim() ||
    cfg.webApiGatewayUrlDefault ||
    networkEndpoints.broker.ibkr.gatewayUrlDefault;
  const pathHint = process.env.IBKR_GATEWAY_PATH?.trim();

  if (opts.expectStopped) {
    const open = await probeTcpPort('127.0.0.1', 5000, 1200);
    if (!open) {
      return baseEntry({
        health: 'STOPPED',
        detail: 'IBKR Client Portal Gateway not listening (expected after stop/nuke)',
        action: null,
        provider: 'Interactive Brokers Client Portal',
        endpoint: baseUrl,
        latencyMs: null,
        loaded: false,
        probeMode: 'web_api',
        activeBrokerId,
      });
    }
  }

  const p = await probeIbkrClientPortalAuthStatus(baseUrl, 4000);
  if (!p.reachable) {
    return baseEntry({
      health: 'FAILED',
      detail: p.error || 'Client Portal unreachable on :5000',
      action:
        'Set IBKR_GATEWAY_PATH to Client Portal folder and complete 2FA login at https://localhost:5000.' +
        (pathHint ? ` (IBKR_GATEWAY_PATH=${pathHint})` : ''),
      provider: 'Interactive Brokers Client Portal',
      endpoint: baseUrl,
      latencyMs: p.latencyMs,
      loaded: false,
      probeMode: 'web_api',
      activeBrokerId,
    });
  }
  if (p.authenticated) {
    return baseEntry({
      health: 'READY',
      detail: 'Client Portal reachable and brokerage session authenticated',
      action: null,
      provider: 'Interactive Brokers Client Portal',
      endpoint: baseUrl,
      latencyMs: p.latencyMs,
      loaded: true,
      probeMode: 'web_api',
      activeBrokerId,
    });
  }
  return baseEntry({
    health: 'STARTING',
    detail: 'Client Portal reachable (HTTP 401 — login pending). Complete browser 2FA.',
    action: 'Set IBKR_GATEWAY_PATH to Client Portal folder and complete 2FA login at https://localhost:5000.',
    provider: 'Interactive Brokers Client Portal',
    endpoint: baseUrl,
    latencyMs: p.latencyMs,
    loaded: false,
    probeMode: 'web_api',
    activeBrokerId,
  });
}

function probeStandby(
  activeBrokerId: string | null,
): IbkrEcosystemHealthResult {
  const label = activeBrokerId || 'non-IBKR';
  return baseEntry({
    health: 'DISABLED',
    detail: `IBKR STANDBY/INACTIVE — active broker is ${label} (not probing Gateway :4002 or Client Portal :5000)`,
    action: null,
    provider: 'Interactive Brokers (standby)',
    endpoint: 'n/a',
    latencyMs: null,
    loaded: false,
    probeMode: 'standby',
    activeBrokerId,
  });
}

/**
 * Run the adaptive IBKR ecosystem probe.
 * Callers should pass `activeBrokerIdOrName` from BrokerManager or settings when known.
 */
export async function probeIbkrEcosystemHealth(
  opts: IbkrEcosystemHealthOptions = {},
): Promise<IbkrEcosystemHealthResult> {
  if (opts.skip || process.env.ARGUS_SKIP_IBKR === 'true') {
    return baseEntry({
      health: 'DISABLED',
      detail: 'Skipped (ARGUS_SKIP_IBKR=true)',
      action: null,
      provider: 'Interactive Brokers',
      endpoint: 'n/a',
      latencyMs: null,
      loaded: false,
      probeMode: 'standby',
      activeBrokerId: opts.activeBrokerIdOrName ?? null,
    });
  }

  const cfg = loadIbkrConnection();
  const active = opts.activeBrokerIdOrName ?? null;
  const mode = resolveIbkrHealthProbeMode(active, cfg.mode);

  if (mode === 'standby') return probeStandby(active);
  if (mode === 'web_api') return probeWebApiMode(opts, active);
  return probeSocketMode(opts, active);
}

/** Optional session account — callers may pass from an allowlisted BrokerManager snapshot. */
export async function resolveIbkrSessionAccountId(): Promise<string | null> {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/v2/runtime/health', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    if (body?.activeBroker?.id !== 'ibkr_gateway') return null;
    const acct = body?.activeBroker?.connection?.accountId;
    return typeof acct === 'string' && acct.trim() ? acct.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Active broker for health probes — never imports BrokerManager (architecture allowlist).
 * Prefer HTTP runtime health when Argus is up; else settings.selectedBroker from SQLite.
 */
export async function resolveActiveBrokerIdForHealth(): Promise<string | null> {
  const viaHttp = await resolveActiveBrokerIdViaHttp();
  if (viaHttp) return viaHttp;
  return resolveActiveBrokerIdFromSettings();
}

export async function resolveActiveBrokerIdViaHttp(): Promise<string | null> {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/v2/runtime/health', {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body: any = await res.json();
      const id = body?.activeBroker?.id;
      if (typeof id === 'string' && id.trim()) return id.trim();
      const name = body?.activeBroker?.name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  } catch {
    /* Argus not listening */
  }
  return null;
}

export async function resolveActiveBrokerIdFromSettings(): Promise<string | null> {
  try {
    const { db } = await import('../db');
    const schema = await import('../db/schema');
    const rows = await db
      .select({ selectedBroker: schema.settings.selectedBroker })
      .from(schema.settings)
      .limit(1);
    const name = rows[0]?.selectedBroker;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}
