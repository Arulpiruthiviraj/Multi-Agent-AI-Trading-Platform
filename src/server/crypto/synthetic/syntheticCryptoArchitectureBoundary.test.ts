import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Architecture boundary for the synthetic crypto population engine
 * (src/server/crypto/synthetic/). Same static-scan pattern as
 * src/server/crypto/cryptoArchitectureBoundary.test.ts and
 * src/server/premarket/premarketArchitectureBoundary.test.ts, extended with the two invariants
 * this module specifically needs: it can never reach a real broker/database, and it can never be
 * imported by anything in the live spine (mandate: "The synthetic environment must be
 * mechanically incapable of routing an order to IBKR, Alpaca, or another real-money broker").
 */
const DIR = path.join(__dirname);
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}
function importLinesOf(file: string): string[] {
  return sourceOf(file).split('\n').filter((l) => /^\s*import\b/.test(l));
}

describe('ARGUS Crypto V2 Synthetic Population Engine — architecture boundary', () => {
  it('at least one non-test file exists (sanity - this suite should never silently cover zero files)', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('no file calls placeOrder', () => {
    for (const f of FILES) expect(sourceOf(f), f).not.toMatch(/\.placeOrder\s*\(/);
  });

  it('no file imports ChiefTraderAgent, RiskEngine, OrderManagement, BrokerManager, or a broker adapter', () => {
    for (const f of FILES) {
      const hit = importLinesOf(f).some((l) =>
        /ChiefTraderAgent|RiskEngine|OrderManagement|BrokerManager|AlpacaBroker|IBGatewaySocketAdapter|InteractiveBrokersWebApiAdapter|CoinbaseBroker|QuestradeBroker|InternalPaperBroker/.test(l),
      );
      expect(hit, f).toBe(false);
    }
  });

  it('no file imports the production database module', () => {
    for (const f of FILES) {
      const hit = importLinesOf(f).some((l) => /from ['"].*server\/db\/index['"]/.test(l));
      expect(hit, f).toBe(false);
    }
  });

  it('no file imports MarketDataWorker (cannot inject synthetic symbols into real subscriptions)', () => {
    for (const f of FILES) {
      const hit = importLinesOf(f).some((l) => /MarketDataWorker/.test(l));
      expect(hit, f).toBe(false);
    }
  });

  it('no file calls emitTradeIdea (cannot inject into the live idea pipeline)', () => {
    for (const f of FILES) {
      const codeOnly = sourceOf(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(codeOnly, f).not.toMatch(/\.emitTradeIdea\s*\(/);
    }
  });

  it('no file references CHIEF_APPROVED_IDEA', () => {
    for (const f of FILES) {
      const codeOnly = sourceOf(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(codeOnly, f).not.toMatch(/CHIEF_APPROVED_IDEA/);
    }
  });

  it('no file references PAPER_TRADING_ONLY, setLiveMode, evaluateLiveReadiness, or LIVE_ARM', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/PAPER_TRADING_ONLY|setLiveMode|evaluateLiveReadiness|LIVE_ARM\b/);
    }
  });

  it('every generated symbol constant/prefix is SYN-prefixed, never a bare real-looking ticker literal', () => {
    // A cheap structural proxy: the population generator's own symbol-construction code must
    // reference the SYN prefix, not assemble tickers from arbitrary strings alone.
    const generator = sourceOf('SyntheticCryptoPopulationGenerator.ts');
    expect(generator).toMatch(/SYN/);
  });

  it('no file in the live decision spine imports anything from src/server/crypto/synthetic/', () => {
    const spineDirs = ['src/server/core', 'src/server/services', 'src/server/engines', 'src/server/risk', 'src/brokers'];
    const repoRoot = path.join(__dirname, '..', '..', '..', '..');
    for (const dir of spineDirs) {
      const abs = path.join(repoRoot, dir);
      if (!fs.existsSync(abs)) continue;
      const walk = (d: string): string[] =>
        fs.readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) return walk(p);
          return entry.name.endsWith('.ts') ? [p] : [];
        });
      for (const file of walk(abs)) {
        const content = fs.readFileSync(file, 'utf8');
        expect(content, file).not.toMatch(/from ['"].*server\/crypto\/synthetic/);
      }
    }
  });
});
