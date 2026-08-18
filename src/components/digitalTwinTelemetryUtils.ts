/**
 * Pure helpers for Agent Network telemetry UI — testable without React Flow.
 */

export const MAX_EVENT_BUFFER = 150;
export const MAX_TRACE_BUFFER = 50;

export const PACKET_COLOR = {
  market: '#22d3ee',
  idea: '#c084fc',
  chief: '#34d399',
  riskOk: '#34d399',
  reject: '#f59e0b',
  fail: '#fb7185',
  execution: '#eab308',
} as const;

export type TxStage = { type: string; timestamp: string; payload: Record<string, unknown> };

export interface Transaction {
  traceId: string;
  symbol?: string;
  originAgent?: string;
  stages: TxStage[];
  status: 'IDEA' | 'CHIEF_APPROVED' | 'RISK_APPROVED' | 'RISK_VETOED' | 'EXECUTED' | 'NO_CONSENSUS';
  startedAt: string;
  lastUpdate: string;
}

export interface PipelineStep {
  offsetMs: number;
  label: string;
  detail: string;
  eventType: string;
}

export const STAGE_ORDER = [
  'TRADE_IDEA_GENERATED',
  'CHIEF_APPROVED_IDEA',
  'CHIEF_CONSENSUS_COMPLETED',
  'CAPITAL_CHECK',
  'RISK_ASSESSMENT_COMPLETED',
  'ORDER_SUBMITTED',
  'ORDER_ACCEPTED',
  'ORDER_FILLED',
  'ORDER_EXECUTED',
];

export type LogSeverity = 'INFO' | 'WARN' | 'REJECT' | 'EXECUTION' | 'ANOMALY';
export type LogFilter = 'ALL' | 'CONSENSUS' | 'RISK' | 'EXECUTION' | 'TRADING';

const CONSENSUS_TYPES = new Set([
  'TRADE_IDEA_GENERATED',
  'CHIEF_CONSENSUS_STARTED',
  'CHIEF_CONSENSUS_COMPLETED',
  'CHIEF_APPROVED_IDEA',
  'DESK_NO_TRADE',
  'AGENT_DISAGREEMENT',
]);

const RISK_TYPES = new Set([
  'RISK_ASSESSMENT_STARTED',
  'RISK_ASSESSMENT_COMPLETED',
  'RISK_GATE_EVALUATED',
  'RISK_BLOCK',
  'CAPITAL_CHECK',
  'CAPITAL_BLOCK',
]);

const EXECUTION_TYPES = new Set([
  'ORDER_SUBMITTED',
  'ORDER_ACCEPTED',
  'ORDER_FILLED',
  'ORDER_EXECUTED',
]);

export function classifyEventLog(eventType: string): LogSeverity {
  if (EXECUTION_TYPES.has(eventType)) return 'EXECUTION';
  if (
    eventType === 'DESK_NO_TRADE'
    || eventType === 'AGENT_DISAGREEMENT'
    || (eventType === 'CHIEF_CONSENSUS_COMPLETED' && true)
    || eventType === 'RISK_BLOCK'
  ) return 'REJECT';
  if (
    eventType === 'MODEL_UNAVAILABLE'
    || eventType === 'MODEL_FALLBACK'
    || eventType === 'DATA_STALE'
    || eventType === 'RECONCILIATION_EMERGENCY_HALT'
    || eventType === 'SYSTEM_ANOMALY'
  ) return 'ANOMALY';
  if (eventType === 'RISK_ASSESSMENT_COMPLETED') return 'INFO';
  if (eventType.includes('REJECT') || eventType.includes('VETO')) return 'REJECT';
  return 'INFO';
}

export function matchesLogFilter(eventType: string, filter: LogFilter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'CONSENSUS') return CONSENSUS_TYPES.has(eventType);
  if (filter === 'RISK') return RISK_TYPES.has(eventType);
  if (filter === 'EXECUTION') return EXECUTION_TYPES.has(eventType);
  if (filter === 'TRADING') {
    return CONSENSUS_TYPES.has(eventType) || RISK_TYPES.has(eventType) || EXECUTION_TYPES.has(eventType);
  }
  return true;
}

export function buildTransactions(evts: Array<{ type: string; timestamp: string; payload?: Record<string, unknown> }>): Transaction[] {
  const byTrace = new Map<string, Transaction>();
  const chronological = [...evts].reverse();
  for (const evt of chronological) {
    const traceId = String(evt.payload?.traceId || evt.payload?.trace_id || '');
    if (!traceId) continue;
    const inStageOrder = STAGE_ORDER.includes(evt.type)
      || evt.type === 'CHIEF_CONSENSUS_COMPLETED'
      || evt.type === 'DESK_NO_TRADE';
    if (!inStageOrder) continue;

    let tx = byTrace.get(traceId);
    if (!tx) {
      tx = {
        traceId,
        stages: [],
        status: 'IDEA',
        startedAt: evt.timestamp,
        lastUpdate: evt.timestamp,
      };
      byTrace.set(traceId, tx);
    }
    tx.stages.push({ type: evt.type, timestamp: evt.timestamp, payload: evt.payload || {} });
    tx.lastUpdate = evt.timestamp;
    tx.symbol = String(evt.payload?.symbol || tx.symbol || '');
    if (evt.type === 'TRADE_IDEA_GENERATED') {
      tx.originAgent = String(evt.payload?.agent || tx.originAgent || '');
    }
    if (evt.type === 'CHIEF_APPROVED_IDEA') tx.status = 'CHIEF_APPROVED';
    if (evt.type === 'CHIEF_CONSENSUS_COMPLETED' && evt.payload?.approved === false) {
      tx.status = 'NO_CONSENSUS';
    }
    if (evt.type === 'DESK_NO_TRADE') tx.status = 'NO_CONSENSUS';
    if (evt.type === 'RISK_ASSESSMENT_COMPLETED') {
      tx.status = evt.payload?.approved ? 'RISK_APPROVED' : 'RISK_VETOED';
    }
    if (evt.type === 'ORDER_EXECUTED') tx.status = 'EXECUTED';
  }
  return Array.from(byTrace.values())
    .sort((a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime())
    .slice(0, MAX_TRACE_BUFFER);
}

function humanStageLabel(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'TRADE_IDEA_GENERATED':
      return `${payload.agent || 'Agent'} ${payload.side || '—'} thesis (${fmtPct(payload.confidence)})`;
    case 'CHIEF_APPROVED_IDEA':
      return `Chief consensus ${fmtPct(payload.confidence)} ${payload.side || ''}`.trim();
    case 'CHIEF_CONSENSUS_COMPLETED':
      return payload.approved ? 'Chief approved' : `NO_CONSENSUS (${fmtPct(payload.confidence)})`;
    case 'RISK_ASSESSMENT_COMPLETED':
      return payload.approved ? '24-gate risk PASS' : `Risk REJECT (${payload.gate || 'gate'})`;
    case 'ORDER_SUBMITTED':
      return `OMS submit ${payload.side || ''} qty ${payload.quantity ?? '—'}`;
    case 'ORDER_EXECUTED':
      return `Fill @ ${payload.price != null ? Number(payload.price).toFixed(2) : '—'}`;
    default:
      return type.replace(/_/g, ' ');
  }
}

function fmtPct(v: unknown): string {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${(n <= 1 ? n * 100 : n).toFixed(0)}%`;
}

export function buildPipelineSteps(tx: Transaction): PipelineStep[] {
  if (!tx.stages.length) return [];
  const ordered = [...tx.stages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const t0 = new Date(ordered[0].timestamp).getTime();
  return ordered.map((s) => {
    const offsetMs = Math.max(0, new Date(s.timestamp).getTime() - t0);
    const p = s.payload;
    let detail = '';
    if (s.type === 'TRADE_IDEA_GENERATED' && p.symbol && p.currentPrice != null) {
      detail = `${p.symbol} $${Number(p.currentPrice).toFixed(2)}`;
    } else if (s.type === 'ORDER_EXECUTED' && p.symbol) {
      detail = `${p.symbol} filled`;
    } else {
      detail = humanStageLabel(s.type, p);
    }
    return {
      offsetMs,
      label: humanStageLabel(s.type, p),
      detail,
      eventType: s.type,
    };
  });
}

export function getNodeMicroMetric(
  nodeId: string,
  snap: { eventType: string; payload: Record<string, unknown> } | undefined,
): string | null {
  if (!snap) return null;
  const p = snap.payload;
  const d = p.data && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : p;

  switch (nodeId) {
    case 'technical-engine':
      if (d.rsi != null) return `RSI ${Number(d.rsi).toFixed(1)}`;
      if (p.side) return `${p.side} ${fmtPct(p.confidence)}`;
      return null;
    case 'news-agent':
    case 'finbert-model': {
      const s = p.impact && typeof p.impact === 'object'
        ? (p.impact as Record<string, unknown>).sentiment
        : p.news_sentiment ?? p.localConfidence;
      if (s == null) return null;
      const n = Number(s);
      return n >= 0 ? `+${n.toFixed(2)} Bullish` : `${n.toFixed(2)} Bearish`;
    }
    case 'chief-trader':
      if (p.confidence != null) return `${fmtPct(p.confidence)} ${p.side || 'HOLD'}`;
      return null;
    case 'risk-manager':
      if (p.passed === true || p.approved === true) return 'GATES PASS';
      if (p.gate) return `FAIL: ${p.gate}`;
      if (snap.eventType === 'RISK_GATE_EVALUATED') return String(p.gate || 'eval…');
      return null;
    case 'market-data-worker':
      if (p.price != null && p.symbol) return `${p.symbol} $${Number(p.price).toFixed(2)}`;
      return null;
    case 'quant-engine':
      if (p.quant_strategy_id) return String(p.quant_strategy_id).slice(0, 18);
      if (p.side) return `${p.side} ${fmtPct(p.confidence)}`;
      return null;
    default:
      return null;
  }
}
