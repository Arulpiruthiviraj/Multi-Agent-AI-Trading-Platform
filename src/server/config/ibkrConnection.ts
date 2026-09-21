/**
 * Loads config/ibkrConnection.json — IB Gateway socket vs optional Client Portal Web API.
 * Reviewed file; not an operator UI knob.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export type IbkrConnectionMode = 'socket' | 'web_api';

export interface IbkrConnectionConfig {
  mode: IbkrConnectionMode;
  host: string;
  paperGatewayPort: number;
  paperTwsPort: number;
  liveGatewayPort: number;
  liveTwsPort: number;
  clientId: number;
  connectTimeoutMs: number;
  maxMarketDataLines: number;
  /** When present in managedAccounts, prefer this paper/live account id (e.g. DUR…). */
  preferredAccountId: string | null;
  webApiGatewayUrlDefault: string;
  openBrowserOnWebApiStartup: boolean;
  /** 2026-09-20 remediation: IBKR error codes eligible for bounded subscription retry (entitlement-
   *  class rejections only - 354/10089). Never includes 200 (contract-resolution) or 10197
   *  (competing-session) - those keep their own existing, separate handling. */
  marketDataRejectionRetryableCodes: number[];
  /** Per-symbol retry delay schedule after a retryable rejection, indexed by retryCount (capped at
   *  the last entry) - same "cap at last schedule slot" pattern as ReconnectBackoff. */
  marketDataRejectionRetryBackoffMs: number[];
  /** 2026-09-21 Phase 2 remediation: how long to wait with zero evidence (no tick, no error, no
   *  IBKR acknowledgement callback) before flagging an honest NO_ACKNOWLEDGEMENT diagnostic.
   *  Historically (pre-Phase-2) this same value triggered a synthetic rejection (errorCode -1) -
   *  a real adversarial-audit finding: 60s of silence during a closed market or on an illiquid
   *  symbol is not evidence of a broker rejection. This value now only gates a diagnostic flag,
   *  never a state transition into RETRY_WAIT. */
  marketDataConfirmationTimeoutMs: number;
  /** Cadence of the periodic sweep that checks for expired retry cooldowns / unconfirmed reprobes.
   *  One shared timer, not one per symbol - avoids per-symbol timer/generation bookkeeping. */
  marketDataSubscriptionSweepIntervalMs: number;
  /** 2026-09-21 Phase 2: bounded, far-slower-than-explicit-rejection reissue for a symbol that has
   *  been REQUESTING with zero acknowledgement (no marketDataType/tickReqParams callback) for this
   *  long - the genuine self-healing mechanism for the "IBKR never even acknowledges the request"
   *  shape, distinct from and much less aggressive than marketDataRejectionRetryBackoffMs (which is
   *  reserved for an explicit, confirmed broker rejection). */
  marketDataUnconfirmedReprobeMs: number;
  /** 2026-09-21 Phase 2: number of DISTINCT canary (continuousIntelligence.protectedSymbols)
   *  symbols that must independently receive a retryable entitlement error (354/10089) within
   *  entitlementDegradedWindowMs before the account-wide circuit breaker engages. Never triggered
   *  by one symbol alone. */
  entitlementDegradedCanaryThreshold: number;
  /** 2026-09-21 Phase 2: clustering window for the canary threshold above. */
  entitlementDegradedWindowMs: number;
}

function assertMode(v: unknown): IbkrConnectionMode {
  if (v === 'socket' || v === 'web_api') return v;
  throw new Error(`config/ibkrConnection.json mode must be "socket" or "web_api", got ${JSON.stringify(v)}`);
}

function assertPort(name: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new Error(`config/ibkrConnection.json ${name} must be an integer port 1–65535`);
  }
  return v;
}

export function loadIbkrConnection(): IbkrConnectionConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('ibkrConnection.json');
  const envMode = process.env.IBKR_CONNECTION_MODE?.trim().toLowerCase();
  const mode = envMode === 'web_api' || envMode === 'socket'
    ? (envMode as IbkrConnectionMode)
    : assertMode(raw.mode);

  return {
    mode,
    host: typeof raw.host === 'string' && raw.host ? raw.host : '127.0.0.1',
    paperGatewayPort: assertPort('paperGatewayPort', raw.paperGatewayPort),
    paperTwsPort: assertPort('paperTwsPort', raw.paperTwsPort),
    liveGatewayPort: assertPort('liveGatewayPort', raw.liveGatewayPort),
    liveTwsPort: assertPort('liveTwsPort', raw.liveTwsPort),
    clientId: typeof raw.clientId === 'number' && Number.isInteger(raw.clientId) && raw.clientId >= 0
      ? raw.clientId
      : 1,
    connectTimeoutMs: typeof raw.connectTimeoutMs === 'number' && raw.connectTimeoutMs > 0
      ? raw.connectTimeoutMs
      : 10000,
    maxMarketDataLines: typeof raw.maxMarketDataLines === 'number' && raw.maxMarketDataLines > 0
      ? raw.maxMarketDataLines
      : 90,
    preferredAccountId:
      typeof raw.preferredAccountId === 'string' && raw.preferredAccountId.trim()
        ? raw.preferredAccountId.trim()
        : null,
    webApiGatewayUrlDefault:
      (typeof raw.webApiGatewayUrlDefault === 'string' && raw.webApiGatewayUrlDefault)
      || 'https://localhost:5000/v1/api',
    openBrowserOnWebApiStartup: raw.openBrowserOnWebApiStartup === true,
    marketDataRejectionRetryableCodes: Array.isArray(raw.marketDataRejectionRetryableCodes) && raw.marketDataRejectionRetryableCodes.every((n) => typeof n === 'number')
      ? raw.marketDataRejectionRetryableCodes as number[]
      : [354, 10089],
    marketDataRejectionRetryBackoffMs: Array.isArray(raw.marketDataRejectionRetryBackoffMs) && raw.marketDataRejectionRetryBackoffMs.length > 0 && raw.marketDataRejectionRetryBackoffMs.every((n) => typeof n === 'number' && n > 0)
      ? raw.marketDataRejectionRetryBackoffMs as number[]
      : [60000, 120000, 300000, 600000, 900000],
    marketDataConfirmationTimeoutMs: typeof raw.marketDataConfirmationTimeoutMs === 'number' && raw.marketDataConfirmationTimeoutMs > 0
      ? raw.marketDataConfirmationTimeoutMs
      : 60000,
    marketDataSubscriptionSweepIntervalMs: typeof raw.marketDataSubscriptionSweepIntervalMs === 'number' && raw.marketDataSubscriptionSweepIntervalMs > 0
      ? raw.marketDataSubscriptionSweepIntervalMs
      : 30000,
    marketDataUnconfirmedReprobeMs: typeof raw.marketDataUnconfirmedReprobeMs === 'number' && raw.marketDataUnconfirmedReprobeMs > 0
      ? raw.marketDataUnconfirmedReprobeMs
      : 300000,
    entitlementDegradedCanaryThreshold: typeof raw.entitlementDegradedCanaryThreshold === 'number' && raw.entitlementDegradedCanaryThreshold >= 2
      ? raw.entitlementDegradedCanaryThreshold
      : 2,
    entitlementDegradedWindowMs: typeof raw.entitlementDegradedWindowMs === 'number' && raw.entitlementDegradedWindowMs > 0
      ? raw.entitlementDegradedWindowMs
      : 120000,
  };
}

/** Paper-first port order; live ports only when Argus requested LIVE and PAPER_TRADING_ONLY is off. */
export function ibkrSocketPortCandidates(cfg: IbkrConnectionConfig, preferLive: boolean): number[] {
  if (preferLive && process.env.PAPER_TRADING_ONLY !== 'true') {
    return [cfg.liveGatewayPort, cfg.liveTwsPort, cfg.paperGatewayPort, cfg.paperTwsPort];
  }
  return [cfg.paperGatewayPort, cfg.paperTwsPort];
}
