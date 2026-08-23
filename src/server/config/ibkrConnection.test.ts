import { describe, it, expect } from 'vitest';
import { loadIbkrConnection, ibkrSocketPortCandidates } from './ibkrConnection';

describe('ibkrConnection config (socket primary)', () => {
  it('defaults to TCP paper 4002 with clientId 1 and 90 MD lines', () => {
    const prev = process.env.IBKR_CONNECTION_MODE;
    delete process.env.IBKR_CONNECTION_MODE;
    try {
      const cfg = loadIbkrConnection();
      expect(cfg.mode).toBe('socket');
      expect(cfg.host).toBe('127.0.0.1');
      expect(cfg.paperGatewayPort).toBe(4002);
      expect(cfg.clientId).toBe(1);
      expect(cfg.maxMarketDataLines).toBe(90);
      expect(cfg.preferredAccountId).toBe('DUR959160');
      expect(cfg.openBrowserOnWebApiStartup).toBe(false);
      expect(ibkrSocketPortCandidates(cfg, false)).toEqual([4002, 7497]);
    } finally {
      if (prev === undefined) delete process.env.IBKR_CONNECTION_MODE;
      else process.env.IBKR_CONNECTION_MODE = prev;
    }
  });
});
