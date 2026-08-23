import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildArmAutobotPayload } from './AutonomousLaunchModal';

describe('AutonomousLaunchModal 1-click pre-flight', () => {
  it('CONFIRM & ARM payload invokes toggle with Adaptive strategy', () => {
    expect(buildArmAutobotPayload({
      strategyFocus: 'ADAPTIVE_MULTI_STRATEGY',
      tradingMode: 'PAPER',
    })).toEqual({
      strategy: 'ADAPTIVE_MULTI_STRATEGY',
      tradingMode: 'PAPER',
    });
  });

  it('verification sheet has no redundant broker/strategy/agent forms', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/AutonomousLaunchDialog.tsx'), 'utf8');
    expect(src).toMatch(/Confirm &amp; Arm Autobot|Confirm & Arm Autobot/);
    expect(src).toContain('onStart(buildArmAutobotPayload');
    expect(src).not.toMatch(/Execution Broker/);
    expect(src).not.toMatch(/AI Agent Constellation/);
    expect(src).not.toMatch(/Core Strategy/);
    expect(src).not.toMatch(/Polygon\.io/);
  });
});
