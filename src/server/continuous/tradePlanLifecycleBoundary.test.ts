import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { continuousIntelligence, isTradePlanIdeasEnabled } from '../config/continuousIntelligence';

/**
 * Architecture boundary for the premarket plan lifecycle (workstream B, 2026-10-06).
 * TradePlanBuilder and the new premarket lifecycle modules can NEVER place orders, approve
 * trades, or bypass consensus/RiskEngine/OMS. Static-scan pattern, same as
 * src/server/premarket/premarketArchitectureBoundary.test.ts.
 *
 * The ONE exception is the pre-existing, explicitly operator-authorized
 * emitTradePlanIdea() path (2026-09-05): a single gated vote per PRIMARY-tier plan, still
 * behind ARGUS_TRADE_PLAN_IDEAS_ENABLED (OFF by default - asserted below, not changed here).
 */
const FILES = [
  path.join(__dirname, 'TradePlanBuilder.ts'),
  path.join(__dirname, '..', 'premarket', 'PremarketDataReservation.ts'),
  path.join(__dirname, '..', 'premarket', 'premarketRefreshEvents.ts'),
];

function sourceOf(file: string): string {
  return fs.readFileSync(file, 'utf8');
}
/** Code lines only: strips full-line comments (block-comment continuations start with *). */
function codeOf(file: string): string {
  return sourceOf(file)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}
function importLinesOf(file: string): string[] {
  return sourceOf(file).split('\n').filter((l) => /^\s*import\b/.test(l));
}

describe('TradePlan lifecycle — architecture boundary', () => {
  it('covers the expected files (sanity - this suite should never silently cover zero files)', () => {
    for (const f of FILES) expect(fs.existsSync(f), f).toBe(true);
  });

  it('no file calls placeOrder', () => {
    for (const f of FILES) expect(codeOf(f), f).not.toMatch(/\.placeOrder\s*\(/);
  });

  it('no file imports BrokerManager, OMS, RiskEngine, ChiefTraderAgent, or a broker adapter', () => {
    for (const f of FILES) {
      const hit = importLinesOf(f).some((l) =>
        /BrokerManager|OrderManagement|RiskEngine|ChiefTraderAgent|AlpacaBroker|IBGatewaySocketAdapter|InteractiveBrokersWebApiAdapter|CoinbaseBroker|QuestradeBroker|InternalPaperBroker/.test(l),
      );
      expect(hit, f).toBe(false);
    }
  });

  it('no file references CHIEF_APPROVED_IDEA', () => {
    for (const f of FILES) expect(codeOf(f), f).not.toMatch(/CHIEF_APPROVED_IDEA/);
  });

  it('no file references PAPER_TRADING_ONLY, setLiveMode, evaluateLiveReadiness, or LIVE_ARM', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/PAPER_TRADING_ONLY|setLiveMode|evaluateLiveReadiness|LIVE_ARM\b/);
    }
  });

  it('no file mutates consensus thresholds', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/consensusApprovalThreshold\s*=|minIndependentAgreeingAgents\s*=|disagreementPenalty\s*=/);
    }
  });

  it('no scattered timers: no setTimeout/setInterval in the lifecycle modules', () => {
    for (const f of FILES) expect(codeOf(f), f).not.toMatch(/\bset(Timeout|Interval)\s*\(/);
  });

  it('idea emission exists ONLY inside the pre-existing gated emitTradePlanIdea() path', () => {
    const file = FILES[0];
    const src = sourceOf(file);
    const occurrences = [...src.matchAll(/\.emitTradeIdea\s*\(/g)];
    expect(occurrences.length).toBe(1);
    const fnIdx = src.indexOf('export function emitTradePlanIdea(');
    expect(fnIdx).toBeGreaterThan(-1);
    expect(occurrences[0].index!).toBeGreaterThan(fnIdx);
    // The gate is still referenced inside that function - the path stays opt-in.
    const fnBody = src.slice(fnIdx, fnIdx + 4000);
    expect(fnBody).toMatch(/isTradePlanIdeasEnabled\(\)/);
  });

  it('ARGUS_TRADE_PLAN_IDEAS_ENABLED stays env-gated and OFF by default (not changed here)', () => {
    expect(continuousIntelligence.tradePlanIdeasEnabledEnvVar).toBe('ARGUS_TRADE_PLAN_IDEAS_ENABLED');
    const saved = process.env[continuousIntelligence.tradePlanIdeasEnabledEnvVar];
    delete process.env[continuousIntelligence.tradePlanIdeasEnabledEnvVar];
    try {
      expect(isTradePlanIdeasEnabled()).toBe(false);
    } finally {
      if (saved !== undefined) process.env[continuousIntelligence.tradePlanIdeasEnabledEnvVar] = saved;
    }
  });

  it('premarket modules never import the order path transitively via MarketDataWorker usage', () => {
    // PremarketDataReservation may use MarketDataWorker.requestTemporaryDataRescue (subscription
    // priority only) but must never touch an order-placement surface.
    const src = codeOf(FILES[1]);
    expect(src).not.toMatch(/placeOrder|submitOrder|cancelOrder|closePosition/);
  });
});
