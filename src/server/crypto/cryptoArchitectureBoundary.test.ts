import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Architecture boundary for the new ARGUS Crypto V2 module (src/server/crypto/). Same
 * static-scan pattern as src/server/premarket/premarketArchitectureBoundary.test.ts and
 * src/server/research/evolution/evolutionBoundary.test.ts - proven precedent in this codebase
 * for a new extension zone. As of 2026-09-21 this directory holds only the P0 session-clock
 * scaffolding; every future crypto stage (feature bridge, strategy set, execution adapter) adds
 * files under this same directory, so this test's coverage grows automatically with it.
 */
const DIR = path.join(__dirname);
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}
function importLinesOf(file: string): string[] {
  return sourceOf(file).split('\n').filter((l) => /^\s*import\b/.test(l));
}

describe('ARGUS Crypto V2 — architecture boundary', () => {
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

  it('no file calls emitTradeIdea (cannot inject into the live idea pipeline)', () => {
    for (const f of FILES) {
      const codeOnly = sourceOf(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(codeOnly, f).not.toMatch(/\.emitTradeIdea\s*\(/);
    }
  });

  it('no file references CHIEF_APPROVED_IDEA (only the real ChiefTraderAgent may mint that transition)', () => {
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

  it('no file mutates consensus thresholds', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/consensusApprovalThreshold\s*=|minIndependentAgreeingAgents\s*=|disagreementPenalty\s*=/);
    }
  });

  it('only an explicit, reviewed allowlist in the live decision spine imports from src/server/crypto/ - everything else stays unwired', () => {
    // Crypto Expansion Phase 3 (2026-09-21): this invariant was "nothing imports src/server/crypto/
    // yet" - now deliberately relaxed to "only these specific, reviewed files do," each for a named
    // reason. src/server/crypto/synthetic/ and src/server/crypto/live/ remain fully unreachable
    // from the spine (unchanged) - only the pure, side-effect-free CryptoSessionClock.ts (UTC
    // day-boundary math, no market data/order/position awareness - see its own header comment) is
    // now shared, and only by RiskEngine.ts's asset-aware daily-window/venue-availability gates.
    const ALLOWED_SPINE_IMPORTS: Record<string, RegExp[]> = {
      'src/server/engines/RiskEngine.ts': [/from ['"]\.\.\/crypto\/CryptoSessionClock['"]/],
    };
    const spineDirs = ['src/server/core', 'src/server/services', 'src/server/engines', 'src/server/risk', 'src/brokers'];
    const repoRoot = path.join(__dirname, '..', '..', '..');
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
        const relPath = path.relative(repoRoot, file).replace(/\\/g, '/');
        const cryptoImportLines = content.split('\n').filter((l) => /from ['"].*server\/crypto/.test(l));
        if (cryptoImportLines.length === 0) continue;
        const allowed = ALLOWED_SPINE_IMPORTS[relPath];
        expect(allowed, `${relPath} imports from src/server/crypto/ but is not in the reviewed allowlist: ${cryptoImportLines.join(' | ')}`).toBeDefined();
        for (const line of cryptoImportLines) {
          expect(allowed!.some((re) => re.test(line)), `${relPath}: unreviewed crypto import not covered by its allowlist entries: ${line}`).toBe(true);
        }
      }
    }
  });

  it('src/server/crypto/synthetic/ and src/server/crypto/live/ remain fully unreachable from the spine (unaffected by the Phase 3 allowlist above)', () => {
    const spineDirs = ['src/server/core', 'src/server/services', 'src/server/engines', 'src/server/risk', 'src/brokers'];
    const repoRoot = path.join(__dirname, '..', '..', '..');
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
        expect(content, file).not.toMatch(/from ['"].*server\/crypto\/(synthetic|live)/);
      }
    }
  });
});
