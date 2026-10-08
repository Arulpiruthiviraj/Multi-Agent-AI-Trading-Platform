import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const BOOTSTRAP_PATH = path.join(__dirname, 'SystemBootstrap.ts');

/**
 * Memory-leak hunt (2026-10-08, TIMERS/SCHEDULERS): start/stop asymmetry audit of
 * SystemBootstrap. Two start()-armed listeners had no matching stop() call, so their
 * subscriptions stayed armed through the graceful-shutdown drain:
 *   - confluenceCoordinator.start() subscribes to TRADE_IDEA_GENERATED; a late idea during
 *     the drain could trigger on-demand Quant/Kronos evaluations against a closing DB.
 *   - startResearchTriggerEngine() subscribes to ORDER_EXECUTED with no matching stop.
 *
 * SystemBootstrap.stop() is not unit-testable in isolation (start() has process-wide side
 * effects), so this suite statically asserts the wiring - the same pattern as
 * AIProviderHealthCheck.shutdown.test.ts.
 */
describe('SystemBootstrap.stop() unwires every listener it arms in start()', () => {
  const stopBody = (): string => {
    const content = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    const stopMatch = content.match(/^\s{2}stop\(\) \{([\s\S]*?)^\s{2}\}/m);
    expect(stopMatch).not.toBeNull();
    return stopMatch![1];
  };

  it('stop() calls confluenceCoordinator.stop()', () => {
    expect(stopBody()).toContain('confluenceCoordinator.stop()');
  });

  it('stop() calls stopResearchTriggerEngine()', () => {
    expect(stopBody()).toContain('stopResearchTriggerEngine()');
  });

  it('stop() still calls the pre-existing worker stops (no wiring dropped by the edit)', () => {
    const body = stopBody();
    for (const call of [
      'chiefTrader.stop()',
      'marketRegimeAgent.stop()',
      'stopAIProviderHealthMonitor()',
      'stopAllIdeaAgents()',
      'trainingExampleBuilder.stop()',
      'systemMetricsWorker.stop()',
      'dbBackupService.stop()',
      'marketDataCrossChecker.stop()',
      'stopObservabilityRetentionSweep()',
      'stopOperationalRetentionSweep()',
      'stopProcessTelemetry()',
    ]) {
      expect(body).toContain(call);
    }
  });
});
