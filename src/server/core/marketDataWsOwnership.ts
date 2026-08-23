/**
 * Alpaca IEX quote WebSocket must be owned by a single primary Argus process
 * (server.ts / ArgusCoreBoot / engine daemon). CLI probes, soak scripts, and
 * accidental imports must not open a second stream against the same credentials.
 */
let authorized = false;
let authorizedBy: string | null = null;

/** Call once from ArgusCoreBoot / SystemBootstrap before marketDataWorker.start(). */
export function authorizeMarketDataWebSocket(owner: string): void {
  authorized = true;
  authorizedBy = owner;
}

export function revokeMarketDataWebSocketAuthorization(): void {
  authorized = false;
  authorizedBy = null;
}

export function isMarketDataWebSocketAuthorized(): boolean {
  if (process.env.ARGUS_DISABLE_MARKET_DATA_WS === 'true') return false;
  // Vitest exercises connectAlpaca with a mock socket — allow without boot owner.
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return true;
  return authorized;
}

export function marketDataWebSocketOwner(): string | null {
  return authorizedBy;
}
