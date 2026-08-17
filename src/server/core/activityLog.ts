/**
 * Activity Log formatters for TradingEngine.state.history.
 *
 * Honest, lossy-on-purpose: only safe published fields (agent, side, confidence,
 * gate id, traceId, price, NO_TRADE code, published reasoning). Never invents
 * chain-of-thought or fills missing fields with placeholders that look real.
 */
export type ActivityLogType =
  | 'scan'
  | 'approve'
  | 'risk'
  | 'veto'
  | 'execute'
  | 'reject'
  | 'no_trade'
  | 'reflect'
  | 'start'
  | 'stop'
  | 'info'
  | 'error';

export interface ActivityLogDetail {
  event?: string;
  agent?: string;
  symbol?: string;
  side?: string;
  confidence?: number;
  reason?: string;
  traceId?: string;
  traceShort?: string;
  gate?: string;
  price?: number;
  qty?: number;
  noTradeCode?: string;
  status?: string;
  evR?: number;
}

export interface ActivityLogEntry {
  time: string;
  type: string;
  msg: string;
  detail?: ActivityLogDetail;
}

export interface FormattedActivity {
  type: ActivityLogType;
  msg: string;
  detail: ActivityLogDetail;
}

const REASON_CLIP = 180;

export function shortTraceId(traceId?: unknown): string | undefined {
  if (typeof traceId !== 'string' || !traceId.trim()) return undefined;
  const t = traceId.trim();
  return t.length <= 12 ? t : `${t.slice(0, 8)}…`;
}

export function clipText(value: unknown, max = REASON_CLIP): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** TRADE_IDEA confidence is 0–1. Values already on 0–100 are left as percent. */
export function formatConfidence(value: unknown): string | undefined {
  const n = finiteNumber(value);
  if (n === undefined) return undefined;
  const pct = n <= 1 ? n * 100 : n;
  return `${pct.toFixed(0)}%`;
}

function formatPrice(value: unknown): string | undefined {
  const n = finiteNumber(value);
  if (n === undefined) return undefined;
  return `$${n.toFixed(2)}`;
}

function joinParts(parts: Array<string | undefined | null | false>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

export function extractNoTradeCode(payload: any): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if (typeof payload.code === 'string' && payload.code.trim()) return payload.code.trim();
  const thesis = payload.quantDetail?.tradeThesis;
  if (thesis?.finalDecision === 'NO_TRADE' && typeof thesis?.noTrade?.code === 'string') {
    return thesis.noTrade.code;
  }
  if (typeof thesis?.noTradeCode === 'string' && thesis.noTradeCode.trim()) return thesis.noTradeCode.trim();
  return undefined;
}

function extractEvR(payload: any): number | undefined {
  const fromThesis = finiteNumber(payload?.quantDetail?.tradeThesis?.estimatedExpectedValue);
  if (fromThesis !== undefined) return fromThesis;
  return finiteNumber(payload?.quantDetail?.expectedValueR);
}

function baseDetail(payload: any, event: string): ActivityLogDetail {
  const confidence = finiteNumber(payload?.confidence);
  const price = finiteNumber(payload?.currentPrice ?? payload?.price);
  const qty = finiteNumber(payload?.maxQuantity ?? payload?.quantity);
  const reason = clipText(payload?.reasoning ?? payload?.reason, 400);
  const traceId = typeof payload?.traceId === 'string' ? payload.traceId : undefined;
  const agent = typeof payload?.agent === 'string' && payload.agent.trim() ? payload.agent.trim() : undefined;
  const symbol = typeof payload?.symbol === 'string' && payload.symbol.trim() ? payload.symbol.trim() : undefined;
  const side = typeof payload?.side === 'string' && payload.side.trim() ? payload.side.trim() : undefined;
  const gate = typeof payload?.rejectionGate === 'string' && payload.rejectionGate.trim()
    ? payload.rejectionGate.trim()
    : typeof payload?.gate === 'string' && payload.gate.trim() ? payload.gate.trim() : undefined;
  const noTradeCode = extractNoTradeCode(payload);
  const status = typeof payload?.status === 'string' && payload.status.trim() ? payload.status.trim() : undefined;
  const evR = extractEvR(payload);
  return {
    event,
    ...(agent ? { agent } : {}),
    ...(symbol ? { symbol } : {}),
    ...(side ? { side } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reason ? { reason } : {}),
    ...(traceId ? { traceId, traceShort: shortTraceId(traceId) } : {}),
    ...(gate ? { gate } : {}),
    ...(price !== undefined ? { price } : {}),
    ...(qty !== undefined ? { qty } : {}),
    ...(noTradeCode ? { noTradeCode } : {}),
    ...(status ? { status } : {}),
    ...(evR !== undefined ? { evR } : {}),
  };
}

export function formatTradeIdeaLog(idea: any): FormattedActivity {
  const detail = baseDetail(idea, 'TRADE_IDEA_GENERATED');
  const agent = detail.agent || 'unknown-agent';
  const symbol = detail.symbol || '?';
  const side = detail.side || '?';
  const msg = joinParts([
    `${agent} proposed ${side} ${symbol}`,
    detail.confidence !== undefined ? `conf ${formatConfidence(detail.confidence)}` : undefined,
    detail.price !== undefined ? `@ ${formatPrice(detail.price)}` : undefined,
    detail.evR !== undefined ? `EV ${detail.evR.toFixed(2)}R` : undefined,
    detail.traceShort ? `trace ${detail.traceShort}` : undefined,
    detail.noTradeCode ? `NO_TRADE ${detail.noTradeCode}` : undefined,
    detail.reason ? `— ${clipText(detail.reason, REASON_CLIP)}` : undefined,
  ]);
  return { type: 'scan', msg, detail };
}

export function formatChiefApprovedLog(idea: any): FormattedActivity {
  const detail = { ...baseDetail(idea, 'CHIEF_APPROVED_IDEA'), agent: 'ChiefTrader' };
  if (typeof idea?.agentsContext === 'string' && idea.agentsContext.trim() && !detail.reason) {
    detail.reason = clipText(`Agreed: ${idea.agentsContext}`, 400);
  }
  const symbol = detail.symbol || '?';
  const side = detail.side || '?';
  const agreed = typeof idea?.agentsContext === 'string' && idea.agentsContext.trim()
    ? `agreed [${clipText(idea.agentsContext, 80)}]`
    : undefined;
  const msg = joinParts([
    `ChiefTrader approved ${side} ${symbol}`,
    detail.confidence !== undefined ? `conf ${formatConfidence(detail.confidence)}` : undefined,
    detail.price !== undefined ? `@ ${formatPrice(detail.price)}` : undefined,
    detail.traceShort ? `trace ${detail.traceShort}` : undefined,
    agreed,
    detail.reason ? `— ${clipText(detail.reason, REASON_CLIP)}` : undefined,
  ]);
  return { type: 'approve', msg, detail };
}

export function formatRiskAssessmentLog(assessment: any): FormattedActivity {
  const detail = baseDetail(assessment, 'RISK_ASSESSMENT_COMPLETED');
  if (!detail.agent) detail.agent = 'RiskEngine';
  const symbol = detail.symbol || '?';
  const side = detail.side || '';
  const gateBit = detail.gate ? `[gate=${detail.gate}]` : undefined;
  if (assessment?.approved) {
    const qtyBit = detail.qty !== undefined ? `qty ${detail.qty}` : undefined;
    const msg = joinParts([
      `RiskEngine approved ${side} ${symbol}`.replace(/\s+/g, ' ').trim(),
      qtyBit,
      detail.price !== undefined ? `@ ${formatPrice(detail.price)}` : undefined,
      detail.traceShort ? `trace ${detail.traceShort}` : undefined,
      detail.reason ? `— ${clipText(detail.reason, REASON_CLIP)}` : undefined,
    ]);
    return { type: 'risk', msg, detail };
  }
  const msg = joinParts([
    `RiskEngine vetoed ${side} ${symbol}`.replace(/\s+/g, ' ').trim(),
    gateBit,
    detail.price !== undefined ? `@ ${formatPrice(detail.price)}` : undefined,
    detail.traceShort ? `trace ${detail.traceShort}` : undefined,
    detail.reason ? `— ${clipText(detail.reason, REASON_CLIP)}` : undefined,
  ]);
  return { type: 'veto', msg, detail };
}

export function formatOrderExecutedLog(order: any): FormattedActivity {
  const detail = baseDetail(order, 'ORDER_EXECUTED');
  const status = (detail.status || 'UNKNOWN').toUpperCase();
  const symbol = detail.symbol || '?';
  const side = detail.side || '?';
  const qty = detail.qty !== undefined ? `${detail.qty}x` : '';
  const filled = status === 'FILLED' || status === 'PARTIALLY_FILLED';
  const type: ActivityLogType = filled ? 'execute' : status === 'REJECTED' || status === 'CANCELED' || status === 'CANCELLED' ? 'reject' : 'execute';
  const verb = filled ? 'OMS filled' : status === 'REJECTED' ? 'OMS rejected' : status === 'CANCELED' || status === 'CANCELLED' ? 'OMS canceled' : `OMS ${status}`;
  const msg = joinParts([
    `${verb} ${side} ${qty} ${symbol}`.replace(/\s+/g, ' ').trim(),
    detail.price !== undefined ? `@ ${formatPrice(detail.price)}` : undefined,
    detail.traceShort ? `trace ${detail.traceShort}` : undefined,
  ]);
  return { type, msg, detail };
}

export function formatDeskNoTradeLog(payload: any): FormattedActivity {
  const detail = baseDetail(payload, 'DESK_NO_TRADE');
  const symbol = detail.symbol || '?';
  const side = detail.side ? `${detail.side} ` : '';
  const code = detail.noTradeCode ? `[${detail.noTradeCode}]` : undefined;
  const msg = joinParts([
    `NO_TRADE ${side}${symbol}`.replace(/\s+/g, ' ').trim(),
    code,
    detail.confidence !== undefined ? `conf ${formatConfidence(detail.confidence)}` : undefined,
    detail.traceShort ? `trace ${detail.traceShort}` : undefined,
    detail.reason ? `— ${clipText(detail.reason, REASON_CLIP)}` : undefined,
  ]);
  return { type: 'no_trade', msg, detail };
}

export function formatLearnedRuleLog(rule: any): FormattedActivity {
  const text = clipText(rule?.rule ?? rule?.ruleText, 220) || '(empty rule text)';
  return {
    type: 'reflect',
    msg: `Reflection Engine extracted rule: ${text}`,
    detail: { event: 'LEARNED_NEW_RULE', reason: text },
  };
}

export function formatAutobotEnabledLog(state: { tradingMode?: string; budget?: number }): FormattedActivity {
  const mode = state.tradingMode || 'UNKNOWN';
  const budget = finiteNumber(state.budget);
  const budgetBit = budget !== undefined ? `Budget: $${budget}` : undefined;
  return {
    type: 'start',
    msg: joinParts([
      `Autobot ENABLED. Mode: ${mode}`,
      budgetBit,
      '— new BUY risk may proceed through RiskEngine.',
    ]),
    detail: { event: 'AUTOBOT_ENABLED' },
  };
}

export function formatAutobotDisabledLog(): FormattedActivity {
  return {
    type: 'stop',
    msg: 'Autobot DISABLED. New BUY risk is blocked; SELL/exits still run while TRADING_ENABLED.',
    detail: { event: 'AUTOBOT_DISABLED', noTradeCode: 'AUTOBOT_DISABLED' },
  };
}
