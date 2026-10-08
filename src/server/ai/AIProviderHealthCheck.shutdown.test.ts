import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const BOOTSTRAP_PATH = path.join(__dirname, '..', 'core', 'SystemBootstrap.ts');

/**
 * DEF-4 regression: startAIProviderHealthMonitor() (started at boot in ArgusCoreBoot.ts) runs a
 * 180s interval that was never stopped on shutdown - stopAIProviderHealthMonitor() was only
 * called from test reset. SystemBootstrap.stop() (invoked by the graceful-shutdown drain BEFORE
 * sqliteDb.close()) must stop it, otherwise its tick can fire during the drain.
 *
 * SystemBootstrap.stop() is not unit-testable in isolation (start() has process-wide side
 * effects), so this suite statically asserts the wiring - the same pattern as
 * StrategyEngineShadowRunner.safety.test.ts.
 */
describe('DEF-4: AI provider health monitor is stopped during SystemBootstrap.stop()', () => {
  it('SystemBootstrap imports stopAIProviderHealthMonitor', () => {
    const content = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    expect(content).toMatch(/stopAIProviderHealthMonitor/);
  });

  it('SystemBootstrap.stop() method body calls stopAIProviderHealthMonitor()', () => {
    const content = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    const stopMatch = content.match(/^\s{2}stop\(\) \{([\s\S]*?)^\s{2}\}/m);
    expect(stopMatch).not.toBeNull();
    expect(stopMatch![1]).toContain('stopAIProviderHealthMonitor()');
  });
});
