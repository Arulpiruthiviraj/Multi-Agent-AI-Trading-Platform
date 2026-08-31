import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Architecture boundary for Phase 10's Agent Edge Discovery & Strategy Validation modules
 * (2026-08-31). Same static-scan pattern as premarketArchitectureBoundary.test.ts /
 * evolutionBoundary.test.ts - proven precedent in this codebase. These modules are read-only
 * statistical observability over already-persisted agent_predictions/prediction_outcomes/
 * agent_performance_stats/calibration data; they must never gain a path into the live order path,
 * and must remain PAPER-only in spirit (no live-trading references at all).
 */
const DIR = path.join(__dirname);
const FILES = [
  'agentEdgeAnalytics.ts',
  'agentDependenceAnalysis.ts',
  'chronologicalEdgeValidation.ts',
  'agentTradingEligibility.ts',
  'agentWeightConsistency.ts',
  'strategyReadiness.ts',
];

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}
function importLinesOf(file: string): string[] {
  return sourceOf(file).split('\n').filter((l) => /^\s*import\b/.test(l));
}

describe('Agent Edge Discovery — architecture boundary', () => {
  it('every expected file exists (sanity - this suite should never silently cover zero files)', () => {
    for (const f of FILES) expect(fs.existsSync(path.join(DIR, f)), f).toBe(true);
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

  it('no file references CHIEF_APPROVED_IDEA', () => {
    for (const f of FILES) {
      const codeOnly = sourceOf(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(codeOnly, f).not.toMatch(/CHIEF_APPROVED_IDEA/);
    }
  });

  it('no file references setLiveMode or LIVE_ARM, or mutates PAPER_TRADING_ONLY', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/setLiveMode|LIVE_ARM\b|PAPER_TRADING_ONLY\s*=/);
    }
  });

  it('no file mutates consensus thresholds, agent weights config, or writes agent_confidence_calibration', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/consensusApprovalThreshold\s*=|minIndependentAgreeingAgents\s*=|disagreementPenalty\s*=/);
      const hit = importLinesOf(f).some((l) => /db\/schema/.test(l)) && sourceOf(f).match(/\.insert\(\s*agentConfidenceCalibration\s*\)|\.update\(\s*agentConfidenceCalibration\s*\)/);
      expect(hit, f).toBeFalsy();
    }
  });
});
