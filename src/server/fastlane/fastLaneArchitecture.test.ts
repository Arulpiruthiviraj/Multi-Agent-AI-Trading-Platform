// LABEL: ARCHITECTURE_INVARIANT
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * 2026-10-05 (Fast Opportunity Lane safety boundary): architecture tests proving
 * the fast lane CANNOT bypass the protected execution spine. If any of these
 * fail, the fast lane has grown an unauthorized execution path and must be
 * blocked from promotion.
 *
 * The fast lane must terminate at the SAME spine:
 *   FastOpportunity → strategy/agent evidence → ChiefTraderAgent → RiskEngine
 *   → PositionSizing → OMS → BrokerManager
 *
 * There must be NO: FastOrderService, FastBrokerPath, DirectPlaceOrder, RiskBypass.
 */
const FASTLANE_DIR = join(__dirname);

function readFastLaneFiles(): Array<{ name: string; content: string }> {
  return readdirSync(FASTLANE_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ name: f, content: stripComments(readFileSync(join(FASTLANE_DIR, f), 'utf8')) }));
}

/** Remove line and block comments so doc mentions don't trigger false positives. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('FastLane architecture safety boundary', () => {
  const files = readFastLaneFiles();

  it('no fastlane file imports BrokerManager', () => {
    for (const f of files) {
      expect(f.content, `${f.name} must not import BrokerManager`).not.toMatch(/from ['"].*BrokerManager['"]/);
      expect(f.content, `${f.name} must not reference BrokerManager`).not.toMatch(/BrokerManager\.getInstance/);
    }
  });

  it('no fastlane file places or cancels orders', () => {
    for (const f of files) {
      expect(f.content, `${f.name} must not place orders`).not.toMatch(/\.placeOrder\s*\(/);
      expect(f.content, `${f.name} must not cancel orders`).not.toMatch(/\.cancelOrder\s*\(/);
    }
  });

  it('no fastlane file mutates RiskEngine state', () => {
    for (const f of files) {
      // Reading risk state for evaluation is fine; mutating it is not.
      expect(f.content, `${f.name} must not mutate RiskEngine`).not.toMatch(/riskEngine\.(set|update|override|bypass)/i);
    }
  });

  it('no fastlane file creates OMS orders', () => {
    for (const f of files) {
      expect(f.content, `${f.name} must not create OMS orders`).not.toMatch(/OrderManagementService/);
      expect(f.content, `${f.name} must not reference OMS`).not.toMatch(/\bOMS\b/);
    }
  });

  it('no forbidden bypass modules exist', () => {
    const forbidden = ['FastOrderService', 'FastBrokerPath', 'DirectPlaceOrder', 'RiskBypass'];
    for (const f of files) {
      for (const name of forbidden) {
        expect(f.content, `${f.name} must not contain ${name}`).not.toContain(name);
      }
    }
    const fileNames = readdirSync(FASTLANE_DIR);
    for (const name of forbidden) {
      expect(fileNames.some((f) => f.includes(name)), `forbidden module ${name} must not exist`).toBe(false);
    }
  });

  it('feature flag defaults to disabled and fails closed for LIVE', () => {
    // The flag must not be hardcoded to true anywhere.
    for (const f of files) {
      if (f.name === 'fastLaneConfig.ts') continue;
      expect(f.content, `${f.name} must not hardcode flag=true`).not.toMatch(/FAST_OPPORTUNITY_LANE_ENABLED['"]?\s*=\s*['"]?true/);
    }
  });

  // 2026-10-06 (Fast Opportunity Lane Evaluator, research/paper only): this phase deliberately
  // does NOT wire evaluation into ChiefTrader yet (see fastLaneEvaluator.ts's own header) -
  // evaluation and execution integration are kept separately testable. If a future phase adds
  // emission, it must do so through a NEW, separately-reviewed module (matching the
  // JavaCoreEnsembleVoteService precedent) - not by quietly adding emitTradeIdea here.
  it('fastLaneEvaluator.ts never calls emitTradeIdea - evaluation has no execution authority in this phase', () => {
    const evaluator = files.find((f) => f.name === 'fastLaneEvaluator.ts');
    expect(evaluator, 'fastLaneEvaluator.ts must exist').toBeTruthy();
    expect(evaluator!.content, 'fastLaneEvaluator.ts must not call emitTradeIdea').not.toMatch(/emitTradeIdea\s*\(/);
    expect(evaluator!.content, 'fastLaneEvaluator.ts must not reference ChiefTrader').not.toMatch(/ChiefTrader/);
  });

  it('fastLaneEvaluator.ts and fastLaneEventInjector.ts never reference RiskEngine, PositionSizing, or trading-state mutation', () => {
    for (const name of ['fastLaneEvaluator.ts', 'fastLaneEventInjector.ts']) {
      const f = files.find((x) => x.name === name);
      expect(f, `${name} must exist`).toBeTruthy();
      expect(f!.content, `${name} must not reference RiskEngine`).not.toMatch(/RiskEngine/);
      expect(f!.content, `${name} must not reference PositionSizing`).not.toMatch(/PositionSizing/);
      expect(f!.content, `${name} must not mutate trading state`).not.toMatch(/setTradingState|TRADING_ENABLED\s*=|tradingState\s*=\s*['"]ENABLED/);
      expect(f!.content, `${name} must not set LIVE mode`).not.toMatch(/setLiveMode|LIVE_ARM\s*=\s*true/);
    }
  });

  // 2026-10-06 (Fast Lane -> Canonical Decision Spine Integration, Section 21). This phase's own
  // explicit boundary: Fast canonical evidence may be CONVERTED into the existing idea shape, but
  // must not be EMITTED into ChiefTrader/consensus yet (see fastCanonicalAdapter.ts/
  // fastCanonicalDedup.ts's own headers - evaluation/conversion proven correct first, execution
  // integration is a later, separately-authorized phase). If this test ever fails because a future
  // change adds emitTradeIdea here, that is the trigger to write the dedicated,
  // explicitly-authorized wiring module this phase deliberately did not build - not to silently
  // update this test to allow it.
  it('fastCanonicalAdapter.ts and fastCanonicalDedup.ts never call emitTradeIdea or reference ChiefTrader - conversion/dedup only, no emission in this phase', () => {
    for (const name of ['fastCanonicalAdapter.ts', 'fastCanonicalDedup.ts']) {
      const f = files.find((x) => x.name === name);
      expect(f, `${name} must exist`).toBeTruthy();
      expect(f!.content, `${name} must not call emitTradeIdea`).not.toMatch(/emitTradeIdea\s*\(/);
      expect(f!.content, `${name} must not reference ChiefTrader`).not.toMatch(/ChiefTrader/);
      expect(f!.content, `${name} must not import EventBus`).not.toMatch(/from ['"][^'"]*\/EventBus['"]/);
    }
  });

  it('fastCanonicalAdapter.ts preserves the ORIGINAL strategy identity field name - never hardcodes a Fast-Lane-specific strategy label', () => {
    const f = files.find((x) => x.name === 'fastCanonicalAdapter.ts')!;
    expect(f.content).not.toMatch(/strategy:\s*['"]FAST_LANE/i);
    expect(f.content).not.toContain("strategy: 'FAST_LANE_BUY'");
  });

  it('every fastlane file importing resolveIndependentEvidenceGroup-adjacent logic does so only for classification, never to bypass the independence floor', () => {
    // No fastlane file may hardcode a confidence/threshold bonus tied to its own arrival path -
    // Section 12 ("no confidence bonus"). Speed is not alpha.
    for (const f of files) {
      expect(f.content, `${f.name} must not add a Fast-Lane-specific confidence bonus`).not.toMatch(/confidence\s*\+=|confidence\s*\*\s*1\.\d|FAST_LANE_BONUS/i);
    }
  });
});
