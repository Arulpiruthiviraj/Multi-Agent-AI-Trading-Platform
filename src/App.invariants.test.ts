import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

describe('SPA order-path invariants', () => {
  it('App.tsx does not call BrokerManager or placeOrder', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
    expect(app).not.toMatch(/BrokerManager\.getInstance/);
    expect(app).not.toMatch(/\.placeOrder\(/);
    expect(app).not.toMatch(/\.closePosition\(/);
  });

  it('Command Center mounts LiveReadinessBanner (LIVE_NO_GO is the honest default)', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
    expect(app).toMatch(/LiveReadinessBanner/);
    const banner = readFileSync(join(ROOT, 'src/components/LiveReadinessBanner.tsx'), 'utf8');
    expect(banner).toMatch(/\/api\/v2\/live-readiness/);
    expect(banner).toMatch(/LIVE_NO_GO/);
  });

  it('does not write trading_state from the SPA', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
    expect(app).not.toMatch(/trading_state\s*:/);
    expect(app).toMatch(/TradingPauseOperatorControls/);
  });

  it('dashboard poll joins in-flight fetchState instead of stacking 6s bursts', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
    expect(app).toMatch(/fetchStateInFlight/);
    expect(app).toMatch(/DASHBOARD_POLL_MS/);
    expect(app).not.toMatch(/setInterval\(\(\) => \{\s*fetchState\(\);\s*fetchServerAuditTrail\(\);\s*fetchChaosConfig\(\);/);
  });
});
