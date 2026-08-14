import { describe, it, expect } from 'vitest';
import { pearsonCorrelation, signalValue, computeAgentSynergyMatrix, REAL_AGENT_NAMES, type AgentPredictionRow } from './AgentSynergy';

describe('signalValue', () => {
  it('BUY maps to +confidence', () => {
    expect(signalValue('BUY', 0.8)).toBe(0.8);
  });
  it('SELL maps to -confidence', () => {
    expect(signalValue('SELL', 0.8)).toBe(-0.8);
  });
  it('HOLD (including DATA_UNAVAILABLE) maps to 0', () => {
    expect(signalValue('HOLD', 0)).toBe(0);
  });
});

describe('pearsonCorrelation', () => {
  it('is 1 for perfectly positively correlated series', () => {
    const r = pearsonCorrelation([1, 2, 3, 4], [10, 20, 30, 40]);
    expect(r).toBeCloseTo(1, 5);
  });

  it('is -1 for perfectly negatively correlated series', () => {
    const r = pearsonCorrelation([1, 2, 3, 4], [40, 30, 20, 10]);
    expect(r).toBeCloseTo(-1, 5);
  });

  it('returns null for empty input', () => {
    expect(pearsonCorrelation([], [])).toBeNull();
  });

  it('returns null when one series has zero variance', () => {
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe('computeAgentSynergyMatrix', () => {
  function pred(agentName: string, symbol: string, day: string, prediction: string, confidence: number): AgentPredictionRow {
    return { agentName, symbol, prediction, confidence, timestamp: `${day}T12:00:00.000Z` };
  }

  it('returns null for a pair with fewer than minOverlappingDays overlapping (symbol,day) keys', () => {
    const predictions: AgentPredictionRow[] = [
      pred('TechnicalAgent', 'AAPL', '2026-01-01', 'BUY', 0.8),
      pred('NewsAgent', 'AAPL', '2026-01-01', 'BUY', 0.7),
    ];
    const { agents, matrix } = computeAgentSynergyMatrix(predictions, 5);
    const i = agents.indexOf('TechnicalAgent');
    const j = agents.indexOf('NewsAgent');
    expect(matrix[i][j]).toBeNull();
    expect(matrix[j][i]).toBeNull();
  });

  it('computes a real positive correlation when two agents move together across enough overlapping days', () => {
    const predictions: AgentPredictionRow[] = [];
    const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'];
    const techVals = [0.9, -0.8, 0.7, -0.6, 0.85, -0.75];
    for (let k = 0; k < days.length; k++) {
      predictions.push(pred('TechnicalAgent', 'AAPL', days[k], techVals[k] > 0 ? 'BUY' : 'SELL', Math.abs(techVals[k])));
      predictions.push(pred('NewsAgent', 'AAPL', days[k], techVals[k] > 0 ? 'BUY' : 'SELL', Math.abs(techVals[k])));
    }
    const { agents, matrix, sampleCounts } = computeAgentSynergyMatrix(predictions, 5);
    const i = agents.indexOf('TechnicalAgent');
    const j = agents.indexOf('NewsAgent');
    expect(matrix[i][j]).not.toBeNull();
    expect(matrix[i][j]!).toBeGreaterThan(0.9);
    expect(sampleCounts[i][j]).toBe(6);
  });

  it('diagonal is always 1 (an agent perfectly correlates with itself)', () => {
    const { agents, matrix } = computeAgentSynergyMatrix([]);
    for (let i = 0; i < agents.length; i++) {
      expect(matrix[i][i]).toBe(1);
    }
  });

  it('ignores predictions from agents outside REAL_AGENT_NAMES', () => {
    const predictions: AgentPredictionRow[] = [
      pred('SentimentAgent', 'AAPL', '2026-01-01', 'BUY', 0.9),
      pred('GeopolAgent', 'AAPL', '2026-01-01', 'BUY', 0.9),
    ];
    const { agents, matrix } = computeAgentSynergyMatrix(predictions, 1);
    expect(agents).toEqual(REAL_AGENT_NAMES);
    for (const row of matrix) {
      for (const val of row) {
        expect(val === 1 || val === null).toBe(true);
      }
    }
  });

  it('averages multiple same-day/same-symbol predictions from one agent into a single daily value', () => {
    const predictions: AgentPredictionRow[] = [
      pred('TechnicalAgent', 'AAPL', '2026-01-01', 'BUY', 0.6),
      pred('TechnicalAgent', 'AAPL', '2026-01-01', 'BUY', 1.0),
    ];
    const { agents, sampleCounts } = computeAgentSynergyMatrix(predictions, 1);
    const i = agents.indexOf('TechnicalAgent');
    expect(sampleCounts[i][i]).toBe(1);
  });
});
