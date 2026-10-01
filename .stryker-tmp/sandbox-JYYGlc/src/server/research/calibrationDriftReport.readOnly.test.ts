// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('calibrationDriftReport.ts - read-only / advisory architectural guarantee', () => {
  const source = fs.readFileSync(path.join(__dirname, 'calibrationDriftReport.ts'), 'utf8');

  it('never imports OrderManagement, the live RiskEngine module, ChiefTraderAgent, or PositionSizing', () => {
    expect(source).not.toMatch(/from ['"].*OrderManagement['"]/);
    expect(source).not.toMatch(/from ['"].*\/RiskEngine['"]/);
    expect(source).not.toMatch(/from ['"].*ChiefTraderAgent['"]/);
    expect(source).not.toMatch(/from ['"].*PositionSizing['"]/);
  });

  it('never calls .placeOrder(, emitTradeIdea, or any db write helper (insert/update/delete against the db)', () => {
    expect(source).not.toMatch(/\.placeOrder\(/);
    expect(source).not.toMatch(/emitTradeIdea/);
    expect(source).not.toMatch(/db\.(insert|update|delete)\(/);
  });

  it('labels its output advisory: true unconditionally in the type contract', () => {
    expect(source).toMatch(/advisory:\s*true/);
  });

  it('only reads from db (db.select), never writes', () => {
    const dbCalls = source.match(/db\.\w+\(/g) ?? [];
    for (const call of dbCalls) {
      expect(call).toBe('db.select(');
    }
  });
});

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../continuous/CalibrationCandidateBuilder', () => ({
  fetchAgentPredictionRows: vi.fn(),
  fetchKronosRows: vi.fn(),
  toClusterableRows: (agentName: string, rows: any[]) => rows.map((r) => ({
    symbol: r.symbol, agent: agentName, side: r.side, timestampMs: r.timestampMs, outcome: r.outcome,
  })),
}));

function row(daysAgo: number, outcome: 'WIN' | 'LOSS', symbol = 'AAA'): any {
  return {
    symbol,
    side: 'BUY',
    timestampMs: Date.now() - daysAgo * 24 * 60 * 60 * 1000,
    outcome,
    reasoning: null,
    regime: null,
  };
}

describe('buildCalibrationDriftReport - real behavior against mocked real data sources', () => {
  it('reports INSUFFICIENT_SAMPLE when a window has too few effective observations', async () => {
    const { db } = await import('../db');
    (db.select as any).mockReturnValue({
      from: () => Promise.resolve([{ agentName: 'TechnicalAgent', bucketLow: 0.6, bucketHigh: 0.8, calibratedConfidence: 0.65 }]),
    });
    const { fetchAgentPredictionRows } = await import('../continuous/CalibrationCandidateBuilder');
    (fetchAgentPredictionRows as any).mockResolvedValue([row(1, 'WIN'), row(2, 'LOSS')]);

    const { buildCalibrationDriftReport } = await import('./calibrationDriftReport');
    const report = await buildCalibrationDriftReport(new Date());
    expect(report.advisory).toBe(true);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].verdict).toBe('INSUFFICIENT_SAMPLE');
  });

  it('flags DRIFT_SUSPECTED_DEGRADED when recent window is all losses and prior window was all wins, with sufficient sample', async () => {
    const { db } = await import('../db');
    (db.select as any).mockReturnValue({
      from: () => Promise.resolve([{ agentName: 'TechnicalAgent', bucketLow: 0.6, bucketHigh: 0.8, calibratedConfidence: 0.65 }]),
    });
    const { fetchAgentPredictionRows } = await import('../continuous/CalibrationCandidateBuilder');

    // recentWindowMs/priorWindowMs default to 14 days each; use distinct symbols so the
    // (symbol, agent, side) clustering in toClusterableRows treats each row as independent.
    const recentLosses = Array.from({ length: 10 }, (_, i) => row(i * 0.5, 'LOSS', `R${i}`));
    const priorWins = Array.from({ length: 10 }, (_, i) => row(20 + i * 0.5, 'WIN', `P${i}`));
    (fetchAgentPredictionRows as any).mockResolvedValue([...recentLosses, ...priorWins]);

    const { buildCalibrationDriftReport } = await import('./calibrationDriftReport');
    const report = await buildCalibrationDriftReport(new Date());
    expect(report.rows[0].verdict).toBe('DRIFT_SUSPECTED_DEGRADED');
  });

  it('reports NO_DRIFT_DETECTED when both windows have similar, overlapping accuracy', async () => {
    const { db } = await import('../db');
    (db.select as any).mockReturnValue({
      from: () => Promise.resolve([{ agentName: 'TechnicalAgent', bucketLow: 0.6, bucketHigh: 0.8, calibratedConfidence: 0.65 }]),
    });
    const { fetchAgentPredictionRows } = await import('../continuous/CalibrationCandidateBuilder');
    const mixed = (offset: number) => Array.from({ length: 10 }, (_, i) =>
      row(offset + i * 0.5, i % 2 === 0 ? 'WIN' : 'LOSS', `S${offset}_${i}`));
    (fetchAgentPredictionRows as any).mockResolvedValue([...mixed(0), ...mixed(20)]);

    const { buildCalibrationDriftReport } = await import('./calibrationDriftReport');
    const report = await buildCalibrationDriftReport(new Date());
    expect(report.rows[0].verdict).toBe('NO_DRIFT_DETECTED');
  });

  it('never mutates agent_confidence_calibration - db.select is the only db entry point called', async () => {
    const { db } = await import('../db');
    (db.select as any).mockReturnValue({ from: () => Promise.resolve([]) });
    const { buildCalibrationDriftReport } = await import('./calibrationDriftReport');
    const report = await buildCalibrationDriftReport(new Date());
    expect(report.rows).toHaveLength(0);
    expect(report.advisory).toBe(true);
  });
});
