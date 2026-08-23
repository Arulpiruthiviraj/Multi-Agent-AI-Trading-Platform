import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  authorizeMarketDataWebSocket,
  isMarketDataWebSocketAuthorized,
  revokeMarketDataWebSocketAuthorization,
  marketDataWebSocketOwner,
} from './marketDataWsOwnership';

describe('marketDataWsOwnership', () => {
  const prevDisable = process.env.ARGUS_DISABLE_MARKET_DATA_WS;
  const prevVitest = process.env.VITEST;
  const prevNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    revokeMarketDataWebSocketAuthorization();
    delete process.env.ARGUS_DISABLE_MARKET_DATA_WS;
    // Exercise production gate (vitest normally auto-allows).
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    revokeMarketDataWebSocketAuthorization();
    if (prevDisable === undefined) delete process.env.ARGUS_DISABLE_MARKET_DATA_WS;
    else process.env.ARGUS_DISABLE_MARKET_DATA_WS = prevDisable;
    if (prevVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = prevVitest;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it('denies WS until ArgusCoreBoot/SystemBootstrap authorize', () => {
    expect(isMarketDataWebSocketAuthorized()).toBe(false);
    authorizeMarketDataWebSocket('ArgusCoreBoot');
    expect(isMarketDataWebSocketAuthorized()).toBe(true);
    expect(marketDataWebSocketOwner()).toBe('ArgusCoreBoot');
  });

  it('ARGUS_DISABLE_MARKET_DATA_WS blocks even after authorize (soak/CLI probes)', () => {
    authorizeMarketDataWebSocket('ArgusCoreBoot');
    process.env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';
    expect(isMarketDataWebSocketAuthorized()).toBe(false);
  });
});
