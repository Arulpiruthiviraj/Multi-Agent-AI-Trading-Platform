import { describe, it, expect, afterEach } from 'vitest';
import { normalizeTradingMode, resolveEnvTradingMode } from './tradingModeEnv';

describe('tradingModeEnv', () => {
  const prevMode = process.env.ARGUS_TRADING_MODE;
  const prevPaper = process.env.PAPER_TRADING_ONLY;

  afterEach(() => {
    if (prevMode === undefined) delete process.env.ARGUS_TRADING_MODE;
    else process.env.ARGUS_TRADING_MODE = prevMode;
    if (prevPaper === undefined) delete process.env.PAPER_TRADING_ONLY;
    else process.env.PAPER_TRADING_ONLY = prevPaper;
  });

  it('normalizes common aliases to SIMULATOR|PAPER|LIVE', () => {
    expect(normalizeTradingMode('paper')).toBe('PAPER');
    expect(normalizeTradingMode('Paper')).toBe('PAPER');
    expect(normalizeTradingMode('LIVE')).toBe('LIVE');
    expect(normalizeTradingMode('SIMULATOR')).toBe('SIMULATOR');
  });

  it('ARGUS_TRADING_MODE preselects, and PAPER_TRADING_ONLY demotes LIVE', () => {
    process.env.ARGUS_TRADING_MODE = 'LIVE';
    process.env.PAPER_TRADING_ONLY = 'true';
    const r = resolveEnvTradingMode();
    expect(r.mode).toBe('PAPER');
    expect(r.liveBlockedByEnv).toBe(true);
    expect(r.paperTradingOnly).toBe(true);
  });

  it('ARGUS_TRADING_MODE=PAPER is respected', () => {
    process.env.ARGUS_TRADING_MODE = 'PAPER';
    delete process.env.PAPER_TRADING_ONLY;
    expect(resolveEnvTradingMode().mode).toBe('PAPER');
    expect(resolveEnvTradingMode().source).toBe('ARGUS_TRADING_MODE');
  });
});
