import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Architecture boundary for the real-live-data crypto research module
 * (src/server/crypto/live/). Unlike src/server/crypto/synthetic/, this directory DOES make real
 * network calls (to Alpaca's crypto API) and DOES call the real Java bridge
 * (QuantCoreBridge.fetchResearchStrategy) - that is intentional and reviewed. What this boundary
 * enforces is the deliberate STOP POINT documented in AlpacaCryptoMarketData.ts's header: real
 * data and real Java research computation, never a live trading decision. No file here may
 * import a broker, RiskEngine, OMS, or ChiefTraderAgent, call placeOrder or emitTradeIdea, or
 * reference CHIEF_APPROVED_IDEA/PAPER_TRADING_ONLY/LIVE_ARM.
 */
const DIR = path.join(__dirname);
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}
function importLinesOf(file: string): string[] {
  return sourceOf(file).split('\n').filter((l) => /^\s*import\b/.test(l));
}

describe('ARGUS Crypto V2 live-data bridge — architecture boundary', () => {
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

  it('no file imports the production database module directly', () => {
    for (const f of FILES) {
      const hit = importLinesOf(f).some((l) => /from ['"].*server\/db\/index['"]/.test(l));
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

  it('every real HTTP call in this directory goes through fetch() to a documented Alpaca or Java-bridge host, never a new ad hoc process/IPC channel', () => {
    for (const f of FILES) {
      const codeOnly = sourceOf(f);
      const fetchCalls = codeOnly.match(/fetch\(/g) ?? [];
      // AlpacaCryptoResearchBridge.ts makes no direct fetch() calls of its own - it delegates to
      // AlpacaCryptoMarketData.ts and quantCoreBridge, both already-reviewed clients.
      if (fetchCalls.length === 0) continue;
      expect(codeOnly, f).toMatch(/data\.alpaca\.markets|paper-api\.alpaca\.markets/);
    }
  });

  it('only an explicit, reviewed allowlist in the live decision spine imports from src/server/crypto/live/ - everything else stays unwired', () => {
    // Crypto Expansion Phase 4 (2026-09-21): deliberately relaxed for CryptoMarketDataIngestion.ts,
    // the real BTC/ETH REST-poll-into-MarketDataWorker's-cache worker - it imports
    // getLatestCryptoQuotes() from AlpacaCryptoMarketData.ts (data only, no order/broker calls,
    // still covered by every other check in this file) and writes into MarketDataWorker's existing
    // observed-quote cache. This is the intended, reviewed wiring point Phase 4 adds - everything
    // else in the spine remains fully unreachable from src/server/crypto/live/.
    const ALLOWED_SPINE_IMPORTS: Record<string, RegExp[]> = {
      'src/server/services/CryptoMarketDataIngestion.ts': [/from ['"]\.\.\/crypto\/live\/AlpacaCryptoMarketData['"]/],
    };
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
        // QuantCoreBridge.ts itself is a documented, reviewed dependency THIS directory imports
        // FROM (not the other way around) - excluded from the "nothing imports us back" check.
        if (file.endsWith('QuantCoreBridge.ts')) continue;
        const content = fs.readFileSync(file, 'utf8');
        const relPath = path.relative(repoRoot, file).replace(/\\/g, '/');
        const cryptoLiveImportLines = content.split('\n').filter((l) => /from ['"].*server\/crypto\/live/.test(l));
        if (cryptoLiveImportLines.length === 0) continue;
        const allowed = ALLOWED_SPINE_IMPORTS[relPath];
        expect(allowed, `${relPath} imports from src/server/crypto/live/ but is not in the reviewed allowlist: ${cryptoLiveImportLines.join(' | ')}`).toBeDefined();
        for (const line of cryptoLiveImportLines) {
          expect(allowed!.some((re) => re.test(line)), `${relPath}: unreviewed crypto/live import not covered by its allowlist entries: ${line}`).toBe(true);
        }
      }
    }
  });
});
