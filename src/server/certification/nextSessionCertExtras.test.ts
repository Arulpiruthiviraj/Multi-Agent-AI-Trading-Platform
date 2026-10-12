/**
 * Unit tests for nextSessionCertExtras.ts (Phase 2, certify-next-session):
 * - parseMarketOpenCertifyOutput(): machine-reads the --certify launcher's stdout
 * - computeGoNoGo(): fail-closed GO / NO-GO verdict
 * - buildRealStateSummary(): read-only real-state summary (stub DB + fixture configs)
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRealStateSummary,
  computeGoNoGo,
  parseMarketOpenCertifyOutput,
} from './nextSessionCertExtras';

const PASS_OUTPUT = `=== ARGUS MANDATORY POST-CHANGE MARKET-OPEN CERTIFICATION ===
TEST A (no-trade safety) [seed=12345]:     PASS (tradeObserved=false, zeroTradeReason=NO_SIGNAL_ABOVE_THRESHOLD)
TEST B (tradeable scenario) [seed=12345]:  PASS (tradeObserved=true, firstBlockingStage=none, calibrationSeeded=true)
  NOTE: Test B used a seeded synthetic calibration history - see the report above.
  A PASS here proves pipeline CAPABILITY, not organic empirically-validated alpha.

=== CERTIFICATION SUMMARY ===
TEST A (no-trade safety) [seed=12345]:     PASS (tradeObserved=false, zeroTradeReason=NO_SIGNAL_ABOVE_THRESHOLD)
TEST B (tradeable scenario) [seed=12345]:  PASS (tradeObserved=true, firstBlockingStage=none, calibrationSeeded=true)
  NOTE: Test B used a seeded synthetic calibration history - see the report above.
  A PASS here proves pipeline CAPABILITY, not organic empirically-validated alpha.
OVERALL: PASS (2/2 runs passed)
`;

const FAIL_OUTPUT = `=== ARGUS MANDATORY POST-CHANGE MARKET-OPEN CERTIFICATION ===
TEST A (no-trade safety) [seed=12345]:     FAIL (tradeObserved=true, zeroTradeReason=n/a)
TEST B (tradeable scenario) [seed=12345]:  PASS (tradeObserved=true, firstBlockingStage=none, calibrationSeeded=true)

=== CERTIFICATION SUMMARY ===
TEST A (no-trade safety) [seed=12345]:     FAIL (tradeObserved=true, zeroTradeReason=n/a)
TEST B (tradeable scenario) [seed=12345]:  PASS (tradeObserved=true, firstBlockingStage=none, calibrationSeeded=true)
OVERALL: FAIL (1/2 runs passed)
`;

describe('parseMarketOpenCertifyOutput', () => {
  it('parses a PASS run: both tests, per-test detail, overall PASS', () => {
    const parsed = parseMarketOpenCertifyOutput(PASS_OUTPUT);
    expect(parsed.parsed).toBe(true);
    expect(parsed.overall).toBe('PASS');
    expect(parsed.testA).toHaveLength(1); // deduped: run line + summary line collapse to one
    expect(parsed.testA[0]).toMatchObject({
      seed: 12345,
      certification: 'PASS',
      tradeObserved: false,
    });
    expect(parsed.testB).toHaveLength(1);
    expect(parsed.testB[0]).toMatchObject({
      seed: 12345,
      certification: 'PASS',
      tradeObserved: true,
      calibrationSeeded: true,
    });
  });

  it('parses a FAIL run: Test A FAIL propagates to overall FAIL', () => {
    const parsed = parseMarketOpenCertifyOutput(FAIL_OUTPUT);
    expect(parsed.parsed).toBe(true);
    expect(parsed.overall).toBe('FAIL');
    expect(parsed.testA[0].certification).toBe('FAIL');
    expect(parsed.testA[0].tradeObserved).toBe(true);
  });

  it('collects multi-seed runs separately', () => {
    const multi = PASS_OUTPUT
      .replaceAll('seed=12345', 'seed=12346')
      .replace('OVERALL: PASS (2/2 runs passed)', 'OVERALL: PASS (4/4 runs passed)');
    const parsed = parseMarketOpenCertifyOutput(PASS_OUTPUT + multi);
    expect(parsed.testA.map((r) => r.seed).sort()).toEqual([12345, 12346]);
    expect(parsed.testB.map((r) => r.seed).sort()).toEqual([12345, 12346]);
    expect(parsed.overall).toBe('PASS');
  });

  it('treats unparseable output as fail-closed (parsed=false, overall=FAIL)', () => {
    const parsed = parseMarketOpenCertifyOutput('simulator exploded with no summary\n');
    expect(parsed.parsed).toBe(false);
    expect(parsed.overall).toBe('FAIL');
  });
});

describe('computeGoNoGo', () => {
  it('GO when the driver is READY and the sim was not run', () => {
    const v = computeGoNoGo({
      driverOverallStatus: 'READY',
      driverBlockingChecks: [],
      simStage: { ran: false, pass: false, summary: 'not run' },
    });
    expect(v.goNoGo).toBe('GO');
    expect(v.reasons.join(' ')).toContain('all release checks PASS');
  });

  it('GO when the driver is READY and the sim passed', () => {
    const v = computeGoNoGo({
      driverOverallStatus: 'READY',
      driverBlockingChecks: [],
      simStage: { ran: true, pass: true, summary: 'OVERALL PASS' },
    });
    expect(v.goNoGo).toBe('GO');
  });

  it('NO-GO when the sim ran and failed, with the sim failure in the reasons', () => {
    const v = computeGoNoGo({
      driverOverallStatus: 'READY',
      driverBlockingChecks: [],
      simStage: { ran: true, pass: false, summary: 'OVERALL FAIL' },
    });
    expect(v.goNoGo).toBe('NO-GO');
    expect(v.reasons.join(' ')).toContain('simulated market-open session FAILED');
  });

  it('NO-GO (fail closed) when the driver is READY_WITH_CONDITIONS, naming blocking checks', () => {
    const v = computeGoNoGo({
      driverOverallStatus: 'READY_WITH_CONDITIONS',
      driverBlockingChecks: ['MARKET_DATA_HEALTH'],
      simStage: { ran: false, pass: false, summary: 'not run' },
    });
    expect(v.goNoGo).toBe('NO-GO');
    expect(v.reasons.join(' ')).toContain('READY_WITH_CONDITIONS');
    expect(v.reasons.join(' ')).toContain('MARKET_DATA_HEALTH');
  });

  it('NO-GO when the driver is NO_GO even if the sim passed', () => {
    const v = computeGoNoGo({
      driverOverallStatus: 'NO_GO',
      driverBlockingChecks: ['AUTHORIZED_PAPER_QUANT_STRATEGIES'],
      simStage: { ran: true, pass: true, summary: 'OVERALL PASS' },
    });
    expect(v.goNoGo).toBe('NO-GO');
    expect(v.reasons.join(' ')).toContain('AUTHORIZED_PAPER_QUANT_STRATEGIES');
  });
});

function makeFixtureRoot(opts: { budget?: unknown; safety?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'next-session-fixture-'));
  const configDir = join(root, 'config');
  // config dir must exist for the reads below
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'paperAllocationProfile.json'),
    JSON.stringify({ budget: opts.budget ?? 5000 }),
  );
  writeFileSync(
    join(configDir, 'tradingSafety.json'),
    JSON.stringify(
      opts.safety ?? {
        consensusApprovalThreshold: 0.75,
        minIndependentAgreeingAgents: 2,
        javaQuantVoteMinConfidence: 0.6,
        minQuantIndependentFamilies: 3,
        minQuantIndependentEffectiveCount: 2.5,
      },
    ),
  );
  return root;
}

function stubDb(rows: Array<Record<string, unknown>> | Error) {
  return {
    prepare: (_sql: string) => ({
      all: () => {
        if (rows instanceof Error) throw rows;
        return rows;
      },
    }),
  };
}

describe('buildRealStateSummary', () => {
  it('reports allocation, positions, and safety numbers from config + a read-only DB probe', () => {
    const root = makeFixtureRoot();
    try {
      const summary = buildRealStateSummary({
        productionState: { AUTHORIZED_PAPER_QUANT_STRATEGIES: 0, verdict: 'QUANT_FIRST_OPERATIONALLY_INACTIVE' },
        safetyConfig: JSON.parse(readFileSync(join(root, 'config', 'tradingSafety.json'), 'utf8')),
        db: stubDb([
          { symbol: 'AAPL', quantity: 10, averagePrice: 150, currentPrice: 152, unrealizedPnL: 20, brokerSource: 'paper', currency: 'USD' },
        ]),
        repoRoot: root,
      });
      expect(summary.authorizedPaperQuantStrategies).toBe(0);
      expect(summary.quantVerdict).toBe('QUANT_FIRST_OPERATIONALLY_INACTIVE');
      expect(summary.allocationProfile.budget).toBe(5000);
      expect(summary.allocationProfile.error).toBeUndefined();
      expect(summary.positions.count).toBe(1);
      expect(summary.positions.rows[0].symbol).toBe('AAPL');
      expect(summary.positions.error).toBeUndefined();
      expect(summary.tradingSafety.consensusApprovalThreshold).toBe(0.75);
      expect(summary.tradingSafety.minIndependentAgreeingAgents).toBe(2);
      expect(summary.source).toContain('READ-ONLY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces unreadable allocation config as an error, not a throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'next-session-fixture-'));
    try {
      const summary = buildRealStateSummary({
        productionState: null,
        safetyConfig: {},
        db: stubDb([]),
        repoRoot: root,
      });
      expect(summary.allocationProfile.budget).toBeNull();
      expect(summary.allocationProfile.error).toContain('unreadable');
      expect(summary.authorizedPaperQuantStrategies).toBeNull();
      expect(summary.tradingSafety.consensusApprovalThreshold).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces a failed position probe as an error, not a throw', () => {
    const root = makeFixtureRoot();
    try {
      const summary = buildRealStateSummary({
        productionState: null,
        safetyConfig: {},
        db: stubDb(new Error('no such table: portfolio')),
        repoRoot: root,
      });
      expect(summary.positions.count).toBe(0);
      expect(summary.positions.error).toContain('probe failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
