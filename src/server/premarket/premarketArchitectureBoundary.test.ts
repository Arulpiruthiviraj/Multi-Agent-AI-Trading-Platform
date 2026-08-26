import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Architecture boundary for the new market-day intelligence module (src/server/premarket/).
 * Same static-scan pattern as src/server/research/evolution/evolutionBoundary.test.ts and
 * src/server/research/intelligence/researchIntelligenceBoundary.test.ts - proven precedent in
 * this codebase for a new extension zone. Every future premarket stage (broad-universe
 * activation, candidate ranking, TradePlan persistence, open revalidation, after-close review)
 * adds files under this same directory, so this test's coverage grows automatically with it.
 */
const DIR = path.join(__dirname);
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}
function importLinesOf(file: string): string[] {
  return sourceOf(file).split('\n').filter((l) => /^\s*import\b/.test(l));
}

describe('Pre-Market Intelligence — architecture boundary', () => {
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
});
