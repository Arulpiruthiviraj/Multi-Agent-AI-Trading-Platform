import { describe, expect, it } from 'vitest';
import {
  clipText,
  extractNoTradeCode,
  formatAutobotDisabledLog,
  formatChiefApprovedLog,
  formatConfidence,
  formatDeskNoTradeLog,
  formatOrderExecutedLog,
  formatRiskAssessmentLog,
  formatTradeIdeaLog,
  shortTraceId,
} from './activityLog';

describe('activityLog formatters', () => {
  it('shortens traceIds without inventing one when missing', () => {
    expect(shortTraceId('abcdef12-3456-7890')).toBe('abcdef12…');
    expect(shortTraceId('short-id')).toBe('short-id');
    expect(shortTraceId(undefined)).toBeUndefined();
    expect(shortTraceId('')).toBeUndefined();
  });

  it('formats 0-1 confidence as percent and leaves >1 as already-percent', () => {
    expect(formatConfidence(0.82)).toBe('82%');
    expect(formatConfidence(0)).toBe('0%');
    expect(formatConfidence(75)).toBe('75%');
    expect(formatConfidence(undefined)).toBeUndefined();
  });

  it('SCAN includes agent, side, symbol, conf, price, trace, and published reason (not a fabricated thought)', () => {
    const row = formatTradeIdeaLog({
      agent: 'FundamentalAgent',
      symbol: 'AAPL',
      side: 'HOLD',
      confidence: 0,
      currentPrice: 188.42,
      traceId: 'trace-fundamental-aapl-001',
      reasoning: 'DATA_UNAVAILABLE: Fundamental data providers not configured.',
    });
    expect(row.type).toBe('scan');
    expect(row.msg).toContain('FundamentalAgent proposed HOLD AAPL');
    expect(row.msg).toContain('conf 0%');
    expect(row.msg).toContain('@ $188.42');
    expect(row.msg).toContain('trace trace-fu…');
    expect(row.msg).toContain('DATA_UNAVAILABLE');
    expect(row.detail.agent).toBe('FundamentalAgent');
    expect(row.detail.traceId).toBe('trace-fundamental-aapl-001');
    expect(row.msg).not.toMatch(/Thought/i);
  });

  it('SCAN labels missing agent as unknown-agent instead of dropping identity silently', () => {
    const row = formatTradeIdeaLog({ symbol: 'TSLA', side: 'HOLD' });
    expect(row.msg).toMatch(/^unknown-agent proposed HOLD TSLA/);
    expect(row.detail.agent).toBeUndefined();
  });

  it('extracts NO_TRADE code from desk payload and from quant thesis', () => {
    expect(extractNoTradeCode({ code: 'INSUFFICIENT_EVIDENCE' })).toBe('INSUFFICIENT_EVIDENCE');
    expect(extractNoTradeCode({
      quantDetail: { tradeThesis: { finalDecision: 'NO_TRADE', noTrade: { code: 'EXPECTED_VALUE_TOO_LOW' } } },
    })).toBe('EXPECTED_VALUE_TOO_LOW');
  });

  it('VETO duplicate_signal matches OvertradingGuards wording and includes gate + trace', () => {
    const row = formatRiskAssessmentLog({
      approved: false,
      symbol: 'AAPL',
      side: 'BUY',
      rejectionGate: 'duplicate_signal',
      reasoning: 'Duplicate BUY signal for AAPL within 60s.',
      traceId: 'risk-dup-aaaaaaaa',
      currentPrice: 190.1,
    });
    expect(row.type).toBe('veto');
    expect(row.msg).toContain('RiskEngine vetoed BUY AAPL');
    expect(row.msg).toContain('[gate=duplicate_signal]');
    expect(row.msg).toContain('Duplicate BUY signal for AAPL within 60s.');
    expect(row.msg).toContain('trace risk-dup…');
    expect(row.detail.gate).toBe('duplicate_signal');
  });

  it('risk approval is type=risk (not execute) and does not claim the order already filled', () => {
    const row = formatRiskAssessmentLog({
      approved: true,
      symbol: 'NVDA',
      side: 'BUY',
      maxQuantity: 12,
      reasoning: 'Approved based on 1.0% portfolio risk cap and available BP.',
      traceId: 'ok-trace-1',
    });
    expect(row.type).toBe('risk');
    expect(row.msg).toContain('RiskEngine approved BUY NVDA qty 12');
    expect(row.msg).not.toMatch(/Execut/i);
  });

  it('Chief approval is type=approve with confidence and agreed agents when present', () => {
    const row = formatChiefApprovedLog({
      symbol: 'TSLA',
      side: 'BUY',
      confidence: 0.81,
      reasoning: '[Chief Consensus Approval] Strong agreement.',
      agentsContext: 'TechnicalAgent(wt:0.25), NewsAgent(wt:0.20)',
      traceId: 'chief-1',
    });
    expect(row.type).toBe('approve');
    expect(row.msg).toContain('ChiefTrader approved BUY TSLA');
    expect(row.msg).toContain('conf 81%');
    expect(row.detail.agent).toBe('ChiefTrader');
  });

  it('ORDER_EXECUTED uses broker status — REJECTED is not logged as filled', () => {
    const filled = formatOrderExecutedLog({
      symbol: 'AAPL', side: 'BUY', quantity: 10, price: 188.5, status: 'FILLED', traceId: 'ord-1',
    });
    expect(filled.type).toBe('execute');
    expect(filled.msg).toContain('OMS filled BUY 10x AAPL @ $188.50');

    const rejected = formatOrderExecutedLog({
      symbol: 'AAPL', side: 'BUY', quantity: 10, price: 188.5, status: 'REJECTED', traceId: 'ord-2',
    });
    expect(rejected.type).toBe('reject');
    expect(rejected.msg).toContain('OMS rejected BUY 10x AAPL');
    expect(rejected.msg).not.toMatch(/^Executed /);
  });

  it('DESK_NO_TRADE includes code, reason, and trace', () => {
    const row = formatDeskNoTradeLog({
      symbol: 'NVDA',
      side: 'HOLD',
      code: 'INSUFFICIENT_EVIDENCE',
      confidence: 0.4,
      reason: '[NO TRADE] Confidence 40.0% did not clear 75%.',
      traceId: 'no-trade-nvda',
    });
    expect(row.type).toBe('no_trade');
    expect(row.msg).toContain('NO_TRADE HOLD NVDA');
    expect(row.msg).toContain('[INSUFFICIENT_EVIDENCE]');
    expect(row.msg).toContain('did not clear 75%');
  });

  it('Autobot DISABLED message is accurate (BUY blocked, not a second kill switch)', () => {
    const row = formatAutobotDisabledLog();
    expect(row.type).toBe('stop');
    expect(row.msg).toContain('Autobot DISABLED');
    expect(row.msg).toContain('New BUY risk is blocked');
    expect(row.msg).toContain('SELL/exits still run');
    expect(row.detail.noTradeCode).toBe('AUTOBOT_DISABLED');
  });

  it('clipText never invents content for missing strings', () => {
    expect(clipText(undefined)).toBeUndefined();
    expect(clipText('')).toBeUndefined();
    expect(clipText('a'.repeat(200))?.endsWith('…')).toBe(true);
  });
});
