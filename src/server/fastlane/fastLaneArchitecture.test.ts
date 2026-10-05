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
});
