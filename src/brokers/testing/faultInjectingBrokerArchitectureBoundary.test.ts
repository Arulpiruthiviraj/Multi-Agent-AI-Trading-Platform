import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Architecture boundary for FaultInjectingBroker.ts (Adversarial Synthetic Market & Trading
 * Validation Framework, §18). This is a test-only chaos-broker double - it must never be reachable
 * from the live production spine (BrokerManager, OMS, RiskEngine, ChiefTraderAgent, or any route),
 * only from `.test.ts` files. Matches the pattern every other *ArchitectureBoundary.test.ts in this
 * repo already uses.
 */
const repoRoot = path.join(__dirname, '..', '..', '..');

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(d, entry.name);
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    if (entry.isDirectory()) return walk(p);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [p] : [];
  });
}

describe('FaultInjectingBroker — architecture boundary (test-only, never reachable from the live spine)', () => {
  it('no non-test file anywhere in src/ or server.ts imports FaultInjectingBroker', () => {
    const roots = [path.join(repoRoot, 'src'), path.join(repoRoot, 'server.ts')];
    const offenders: string[] = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const files = fs.statSync(root).isDirectory() ? walk(root) : [root];
      for (const file of files) {
        if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
        if (file.endsWith('FaultInjectingBroker.ts')) continue;
        const content = fs.readFileSync(file, 'utf8');
        if (/from ['"].*FaultInjectingBroker['"]/.test(content)) {
          offenders.push(path.relative(repoRoot, file).replace(/\\/g, '/'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('constructing it around a broker that reports liveTrading:true throws immediately', async () => {
    const { FaultInjectingBroker } = await import('./FaultInjectingBroker');
    const fakeLiveBroker: any = {
      id: 'fake_live', name: 'Fake Live',
      getCapabilities: () => ({ liveTrading: true, paperTrading: false, canPlaceOrders: true, canCancelOrders: true, usEquities: true, canadianEquities: false, crypto: false, options: false, shortSelling: false, streamingMarketData: false, requiresManualReauth: false, extendedHoursOrders: false }),
    };
    expect(() => new FaultInjectingBroker(fakeLiveBroker, { seed: 1 })).toThrow(/liveTrading/);
  });

  it('getCapabilities() always reports liveTrading:false regardless of what the wrapped broker reports', async () => {
    const { FaultInjectingBroker } = await import('./FaultInjectingBroker');
    const { InternalPaperBroker } = await import('../InternalPaperBroker');
    const wrapped = new FaultInjectingBroker(new InternalPaperBroker(), { seed: 1 });
    expect(wrapped.getCapabilities().liveTrading).toBe(false);
  });
});
