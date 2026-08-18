/**
 * Authoritative pre-broker order authorization. RiskEngine still sizes and gates the idea;
 * this module refuses LIVE placement when environment, arm, or live-readiness evidence fails.
 * PAPER is not blocked by LIVE_NO_GO.
 */
import { assertBrokerEnvironmentAllowsOrder, type BrokerEnvironment } from './brokerEnvironment';
import { assertLiveOrdersArmed } from './LiveTradingConfirmation';
import { evaluateLiveReadiness } from './liveReadinessEngine';
import { isPaperTradingOnlyEnforced } from './tradingModeEnv';

export function assertLiveReadinessAllowsOrder(environment: BrokerEnvironment): { ok: boolean; reason: string } {
  if (environment !== 'LIVE') {
    return { ok: true, reason: 'LIVE_READINESS_NOT_APPLICABLE' };
  }
  let report: ReturnType<typeof evaluateLiveReadiness>;
  try {
    report = evaluateLiveReadiness();
  } catch (e) {
    return {
      ok: false,
      reason: `LIVE_READINESS_UNAVAILABLE: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const blockingVerdicts = new Set(['FAIL', 'BLOCKED', 'UNAVAILABLE', 'INSUFFICIENT_EVIDENCE']);
  const blockedMandatory = report.gates.filter((g) => g.mandatory && blockingVerdicts.has(g.verdict));
  if (report.result !== 'LIVE_READY' || blockedMandatory.length > 0 || report.failedMandatory.length > 0) {
    const ids = (blockedMandatory.length ? blockedMandatory.map((g) => `${g.id}:${g.verdict}`) : report.failedMandatory).slice(0, 12);
    return {
      ok: false,
      reason: `LIVE_NO_GO: evaluateLiveReadiness result=${report.result}. Blocking: ${ids.join(',') || 'LIVE_NO_GO'}`,
    };
  }
  return { ok: true, reason: 'LIVE_READINESS_PASS' };
}

export function authorizeProductionOrder(opts: {
  tradingMode?: string | null;
  paperMode?: boolean | number | null;
}): { ok: boolean; environment: BrokerEnvironment; reason: string } {
  const envGate = assertBrokerEnvironmentAllowsOrder(opts);
  if (!envGate.ok) return envGate;

  if (envGate.environment === 'LIVE') {
    if (isPaperTradingOnlyEnforced()) {
      return {
        ok: false,
        environment: envGate.environment,
        reason: 'PAPER_TRADING_ONLY: LIVE orders are blocked by environment lock.',
      };
    }
    const arm = assertLiveOrdersArmed();
    if (!arm.ok) {
      return { ok: false, environment: envGate.environment, reason: arm.reason };
    }
    const ready = assertLiveReadinessAllowsOrder('LIVE');
    if (!ready.ok) {
      return { ok: false, environment: envGate.environment, reason: ready.reason };
    }
  }

  return envGate;
}
