import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Architecture boundary (Section 25) — mirrors research/intelligence/researchIntelligenceBoundary
 * .test.ts's own static-scan pattern for this new subsystem.
 */
const DIR = path.join(__dirname);
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}
function importLinesOf(file: string): string[] {
  return sourceOf(file).split('\n').filter((l) => /^\s*import\b/.test(l));
}

describe('Strategy Evolution Engine — architecture boundary (Section 25)', () => {
  it('no file calls placeOrder', () => {
    for (const f of FILES) expect(sourceOf(f), f).not.toMatch(/\.placeOrder\s*\(/);
  });

  it('no file imports ChiefTraderAgent, RiskEngine, OrderManagement, or BrokerManager', () => {
    for (const f of FILES) {
      const hit = importLinesOf(f).some((l) => /ChiefTraderAgent|RiskEngine|OrderManagement|BrokerManager/.test(l));
      expect(hit, f).toBe(false);
    }
  });

  it('no file calls emitTradeIdea (cannot inject into the live idea pipeline)', () => {
    for (const f of FILES) {
      const codeOnly = sourceOf(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(codeOnly, f).not.toMatch(/\.emitTradeIdea\s*\(/);
    }
  });

  it('no file references PAPER_TRADING_ONLY, setLiveMode, evaluateLiveReadiness, or LIVE_ARM', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/PAPER_TRADING_ONLY|setLiveMode|evaluateLiveReadiness|LIVE_ARM\b/);
    }
  });

  it('no file mutates consensus thresholds — assertPromotionQuarantine is imported, never redefined', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/consensusApprovalThreshold\s*=|minIndependentAgreeingAgents\s*=|disagreementPenalty\s*=/);
    }
    const orchestrator = sourceOf('StrategyEvolutionEngine.ts');
    expect(orchestrator).toMatch(/assertPromotionQuarantine/);
  });

  it('the LLM hypothesis path never bypasses parameter bounds validation', () => {
    const src = sourceOf('EvolutionHypothesis.ts');
    expect(src).toMatch(/validateHypothesisParameters/);
    expect(src).toMatch(/generateBoundedMutations/); // real fallback exists
  });
});
