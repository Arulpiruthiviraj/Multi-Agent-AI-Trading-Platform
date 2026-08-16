/**
 * ==========================================================
 * Module: DigitalTwinVisualizer.tsx
 *
 * Purpose:
 * Event-driven Agent Network telemetry. Every pulse, packet, and glow is keyed off a real
 * WebSocket EventBus event. Idle system => idle graph. No setInterval loops, no Math.random
 * packet streams, no React Flow `animated` dash loops.
 *
 * MARKET_DATA ticks are coalesced (latest tick only in the log; visual pulse throttled) so
 * high-frequency quotes do not block the React thread.
 * ==========================================================
 */

import { useWebSocket } from '../context/WebSocketContext';
import eventCatalog from '../../config/eventNames.json';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import ReactFlow, {
  Background,
  BaseEdge,
  Controls,
  Edge,
  EdgeProps,
  Handle,
  Node,
  Position,
  getBezierPath,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  Activity, Newspaper, Clock, BookOpen, Terminal,
  BrainCircuit, TrendingUp, ShieldCheck, UserCheck, Send, X, Pause, Play,
  Cpu, DollarSign, Layers, Hash,
} from 'lucide-react';
import AgentFocusMode from './AgentFocusMode';

type NodeCategory = 'source' | 'agent' | 'local-model' | 'paid-model' | 'decision' | 'risk' | 'execution';
type VisualStatus = 'IDLE' | 'PULSE' | 'PROCESSING' | 'SUCCESS' | 'FAIL';

interface LastSnapshot {
  eventType: string;
  timestamp: string;
  payload: any;
}

interface Packet {
  id: string;
  color: string;
}

const CATEGORY_STYLE: Record<NodeCategory, { border: string; glow: string; iconBg: string; iconText: string; accent: string }> = {
  source: { border: 'border-cyan-500', glow: 'rgba(34,211,238,0.55)', iconBg: 'bg-cyan-500/20', iconText: 'text-cyan-300', accent: '#22d3ee' },
  agent: { border: 'border-violet-500', glow: 'rgba(167,139,250,0.5)', iconBg: 'bg-violet-500/20', iconText: 'text-violet-300', accent: '#a78bfa' },
  'local-model': { border: 'border-emerald-500', glow: 'rgba(16,185,129,0.5)', iconBg: 'bg-emerald-500/20', iconText: 'text-emerald-300', accent: '#34d399' },
  'paid-model': { border: 'border-amber-500', glow: 'rgba(245,158,11,0.5)', iconBg: 'bg-amber-500/20', iconText: 'text-amber-300', accent: '#fbbf24' },
  decision: { border: 'border-fuchsia-500', glow: 'rgba(232,121,249,0.5)', iconBg: 'bg-fuchsia-500/20', iconText: 'text-fuchsia-300', accent: '#e879f9' },
  risk: { border: 'border-rose-500', glow: 'rgba(244,63,94,0.5)', iconBg: 'bg-rose-500/20', iconText: 'text-rose-300', accent: '#fb7185' },
  execution: { border: 'border-teal-500', glow: 'rgba(45,212,191,0.5)', iconBg: 'bg-teal-500/20', iconText: 'text-teal-300', accent: '#2dd4bf' },
};

const AGENT_NODE: Record<string, string> = {
  TechnicalAgent: 'technical-engine',
  NewsAgent: 'news-agent',
  FundamentalAgent: 'fundamental-agent',
  MacroAgent: 'macro-agent',
  KronosEngine: 'kronos-forecast',
  PortfolioManager: 'portfolio-monitor',
  QuantEngine: 'quant-engine',
};

const NODE_TO_CHIEF_EDGE: Record<string, string> = {
  'technical-engine': 'e-tech-chief',
  'news-agent': 'e-news-chief',
  'fundamental-agent': 'e-fund-chief',
  'macro-agent': 'e-macro-chief',
  'kronos-forecast': 'e-kronos-chief',
  'portfolio-monitor': 'e-port-chief',
  'quant-engine': 'e-quant-chief',
};

const MARKET_FANOUT_EDGES = ['e-market-tech', 'e-market-kronos'];
const PACKET_MS = 550;
const PULSE_MS = 700;
const FLASH_MS = 900;
const TICK_THROTTLE_MS = 125;

function fmt(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number' && Number.isFinite(v)) return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

function hoverRows(nodeId: string, snap: LastSnapshot | undefined, weights: { agentName: string; currentWeight: number | null }[]): { label: string; value: string }[] {
  if (!snap) return [{ label: 'State', value: 'IDLE — no EventBus payload yet' }];
  const p = snap.payload || {};
  const t = snap.eventType;
  const when = snap.timestamp ? new Date(snap.timestamp).toLocaleTimeString() : '—';

  if (nodeId === 'market-data-worker') {
    return [
      { label: 'Event', value: t },
      { label: 'Symbol', value: fmt(p.symbol) },
      { label: 'Price', value: p.price != null ? `$${Number(p.price).toFixed(2)}` : '—' },
      { label: 'Volume', value: fmt(p.volume) },
      { label: 'Received', value: when },
    ];
  }
  if (nodeId === 'news-agent' || nodeId === 'news-providers') {
    const headline = p.headline || p.aiAnalysis?.headline || p.title;
    const finbert = p.impact?.sentiment ?? p.newsDetails?.sentiment ?? p.localConfidence;
    return [
      { label: 'Event', value: t },
      { label: 'Headline', value: headline ? String(headline).slice(0, 120) : '—' },
      { label: 'FinBERT', value: finbert != null ? Number(finbert).toFixed(3) : '—' },
      { label: 'Source', value: fmt(p.source || p.impact?.sentimentSource) },
      { label: 'Received', value: when },
    ];
  }
  if (nodeId === 'finbert-model') {
    return [
      { label: 'Event', value: t },
      { label: 'FinBERT score', value: p.impact?.sentiment != null ? Number(p.impact.sentiment).toFixed(3) : fmt(p.localConfidence) },
      { label: 'Source', value: fmt(p.impact?.sentimentSource || p.localSource) },
      { label: 'Received', value: when },
    ];
  }
  if (nodeId === 'chief-trader') {
    const rows = [
      { label: 'Event', value: t },
      { label: 'Side', value: fmt(p.side) },
      { label: 'Confidence', value: p.confidence != null ? `${(Number(p.confidence) <= 1 ? Number(p.confidence) * 100 : Number(p.confidence)).toFixed(1)}%` : '—' },
      { label: 'Threshold', value: p.threshold != null ? `${(Number(p.threshold) * 100).toFixed(0)}%` : '—' },
      { label: 'Agents', value: fmt(p.agentsContext) },
      { label: 'Received', value: when },
    ];
    for (const w of weights) {
      if (w.currentWeight == null) continue;
      rows.push({ label: `w ${w.agentName}`, value: w.currentWeight.toFixed(3) });
    }
    return rows;
  }
  if (nodeId === 'ollama-llm' || nodeId === 'paid-llm-pool') {
    return [
      { label: 'Event', value: t },
      { label: 'Provider', value: fmt(p.providerName || p.provider || p.modelId) },
      { label: 'Agent', value: fmt(p.agent) },
      { label: 'Latency', value: p.latency != null ? `${p.latency}ms` : '—' },
      { label: 'Success', value: p.success === false || t === 'MODEL_UNAVAILABLE' || t === 'MODEL_FALLBACK' ? 'NO' : p.success === true ? 'YES' : '—' },
      { label: 'Received', value: when },
    ];
  }
  if (nodeId === 'risk-manager') {
    return [
      { label: 'Event', value: t },
      { label: 'Symbol', value: fmt(p.symbol) },
      { label: 'Approved', value: p.approved == null ? fmt(p.passed) : p.approved ? 'YES' : 'NO' },
      { label: 'Gate', value: fmt(p.gate) },
      { label: 'Qty cap', value: fmt(p.maxQuantity) },
      { label: 'Received', value: when },
    ];
  }
  return [
    { label: 'Event', value: t },
    { label: 'Symbol', value: fmt(p.symbol) },
    { label: 'Side', value: fmt(p.side) },
    { label: 'Agent', value: fmt(p.agent) },
    { label: 'Received', value: when },
  ];
}

const TelemetryNode = ({ id, data }: { id: string; data: any }) => {
  const style = CATEGORY_STYLE[data.category as NodeCategory] || CATEGORY_STYLE.agent;
  const status: VisualStatus = data.status || 'IDLE';
  const active = status !== 'IDLE';
  const border =
    status === 'FAIL' ? 'border-rose-400' :
    status === 'SUCCESS' ? 'border-emerald-400' :
    status === 'PROCESSING' ? style.border :
    status === 'PULSE' ? style.border : 'border-slate-800';
  const glow =
    status === 'FAIL' ? 'rgba(244,63,94,0.7)' :
    status === 'SUCCESS' ? 'rgba(16,185,129,0.7)' :
    active ? style.glow : undefined;

  return (
    <div className="group relative">
      {status === 'PULSE' && (
        <motion.div
          key={data.pulseKey}
          className="absolute inset-0 rounded-xl pointer-events-none"
          initial={{ opacity: 0.7, scale: 1 }}
          animate={{ opacity: 0, scale: 1.28 }}
          transition={{ duration: 0.55, ease: 'easeOut' }}
          style={{ boxShadow: `0 0 0 2px ${style.glow}`, background: style.glow }}
        />
      )}
      <motion.div
        layoutId={`agent-node-${id}`}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className={`relative px-4 py-3 w-52 shadow-lg rounded-xl bg-[#0A0F16] border-2 ${border}`}
        style={active && glow ? { boxShadow: `0 0 18px ${glow}` } : undefined}
      >
        <Handle type="target" position={Position.Top} className="w-2 h-2 bg-slate-500 border-none" />
        <div className="flex items-center gap-3">
          <div className={`rounded-lg p-2.5 ${active ? `${style.iconBg} ${style.iconText}` : 'bg-slate-800 text-slate-500'}`}>
            {data.icon}
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-bold text-white uppercase tracking-widest leading-tight truncate">{data.label}</div>
            <div className="text-[8px] text-slate-400 mt-0.5">{data.description}</div>
            <div className={`text-[8px] mt-1 font-mono ${status === 'FAIL' ? 'text-rose-400' : status === 'SUCCESS' ? 'text-emerald-400' : status === 'PROCESSING' ? 'text-amber-300' : active ? style.iconText : 'text-slate-600'}`}>
              {status === 'IDLE' ? 'IDLE' : status}
            </div>
          </div>
        </div>
        <Handle type="source" position={Position.Bottom} className="w-2 h-2 bg-slate-500 border-none" />
      </motion.div>
      <div className="pointer-events-none absolute left-full top-0 z-50 ml-2 hidden w-64 group-hover:block">
        <div className="rounded-lg border border-cyan-500/30 bg-[#0A0F16]/95 p-3 shadow-[0_0_24px_rgba(34,211,238,0.15)] backdrop-blur-sm">
          <div className="mb-2 text-[9px] font-bold uppercase tracking-widest text-cyan-300">{data.label}</div>
          {(data.hoverRows as { label: string; value: string }[] || []).map((row) => (
            <div key={row.label} className="mb-1 flex justify-between gap-2 font-mono text-[9px]">
              <span className="text-slate-500">{row.label}</span>
              <span className="max-w-[9rem] truncate text-right text-slate-200" title={row.value}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

function PacketEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data }: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const packets: Packet[] = data?.packets || [];
  const lit = packets.length > 0;
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: lit ? (packets[packets.length - 1]?.color || '#22d3ee') : (style?.stroke || '#334155'),
          strokeWidth: lit ? 2.5 : 1.5,
          opacity: lit ? 1 : 0.45,
        }}
      />
      {packets.map((p) => (
        <circle key={p.id} r={3.5} fill={p.color} opacity={0.95}>
          <animateMotion dur={`${PACKET_MS}ms`} fill="remove" path={edgePath} />
        </circle>
      ))}
    </>
  );
}

const nodeTypes = { custom: TelemetryNode };
const edgeTypes = { packet: PacketEdge };

interface TxStage { type: string; timestamp: string; payload: any }
interface Transaction {
  traceId: string;
  symbol?: string;
  originAgent?: string;
  stages: TxStage[];
  status: 'IDEA' | 'CHIEF_APPROVED' | 'RISK_APPROVED' | 'RISK_VETOED' | 'EXECUTED';
  startedAt: string;
  lastUpdate: string;
}

const STAGE_ORDER = [
  'TRADE_IDEA_GENERATED', 'CHIEF_APPROVED_IDEA', 'CAPITAL_CHECK', 'RISK_ASSESSMENT_COMPLETED',
  'ORDER_SUBMITTED', 'ORDER_ACCEPTED', 'ORDER_FILLED', 'ORDER_EXECUTED',
];

function buildTransactions(evts: any[]): Transaction[] {
  const byTrace = new Map<string, Transaction>();
  const chronological = [...evts].reverse();
  for (const evt of chronological) {
    const traceId: string | undefined = evt.payload?.traceId || evt.payload?.trace_id;
    if (!traceId || !STAGE_ORDER.includes(evt.type)) continue;
    let tx = byTrace.get(traceId);
    if (!tx) {
      tx = { traceId, stages: [], status: 'IDEA', startedAt: evt.timestamp, lastUpdate: evt.timestamp };
      byTrace.set(traceId, tx);
    }
    tx.stages.push({ type: evt.type, timestamp: evt.timestamp, payload: evt.payload });
    tx.lastUpdate = evt.timestamp;
    tx.symbol = evt.payload?.symbol || tx.symbol;
    if (evt.type === 'TRADE_IDEA_GENERATED') tx.originAgent = evt.payload?.agent || tx.originAgent;
    if (evt.type === 'CHIEF_APPROVED_IDEA') tx.status = 'CHIEF_APPROVED';
    if (evt.type === 'RISK_ASSESSMENT_COMPLETED') tx.status = evt.payload?.approved ? 'RISK_APPROVED' : 'RISK_VETOED';
    if (evt.type === 'ORDER_EXECUTED') tx.status = 'EXECUTED';
  }
  return Array.from(byTrace.values()).sort((a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime());
}

const STATUS_BADGE: Record<Transaction['status'], { label: string; cls: string }> = {
  IDEA: { label: 'IDEA PROPOSED', cls: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30' },
  CHIEF_APPROVED: { label: 'CHIEF APPROVED', cls: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30' },
  RISK_APPROVED: { label: 'RISK APPROVED', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  RISK_VETOED: { label: 'RISK VETOED', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
  EXECUTED: { label: 'EXECUTED', cls: 'bg-teal-500/10 text-teal-400 border-teal-500/30' },
};

const idleEdge = { stroke: '#334155', strokeWidth: 1.5 };

export default function DigitalTwinVisualizer() {
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<any>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [panelTab, setPanelTab] = useState<'transactions' | 'raw'>('transactions');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [weights, setWeights] = useState<{ agentName: string; currentWeight: number | null }[]>([]);

  const seqRef = useRef(0);
  const lastTickPulseRef = useRef(0);
  const nodeTimers = useRef<Map<string, number>>(new Map());
  const packetTimers = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<{
    snapshots: Map<string, LastSnapshot>;
    pulses: Map<string, VisualStatus>;
    packets: { edgeId: string; color: string }[];
    events: any[];
  }>({ snapshots: new Map(), pulses: new Map(), packets: [], events: [] });

  const initialNodes: Node[] = useMemo(() => [
    { id: 'market-data-worker', type: 'custom', position: { x: 20, y: 40 }, data: { label: 'Market Data', icon: <Activity size={18} />, description: 'Alpaca WS ticks', category: 'source', status: 'IDLE', hoverRows: hoverRows('market-data-worker', undefined, []) } },
    { id: 'news-providers', type: 'custom', position: { x: 280, y: 40 }, data: { label: 'News Providers', icon: <Newspaper size={18} />, description: 'RSS / paid news APIs', category: 'source', status: 'IDLE', hoverRows: hoverRows('news-providers', undefined, []) } },
    { id: 'technical-engine', type: 'custom', position: { x: 20, y: 180 }, data: { label: 'Technical Agent', icon: <TrendingUp size={18} />, description: 'RSI/MACD/BB', category: 'agent', status: 'IDLE', hoverRows: hoverRows('technical-engine', undefined, []) } },
    { id: 'quant-engine', type: 'custom', position: { x: 20, y: 320 }, data: { label: 'Quant Engine', icon: <Activity size={18} />, description: 'Off unless QUANT_ENGINE_ENABLED', category: 'agent', status: 'IDLE', hoverRows: hoverRows('quant-engine', undefined, []) } },
    { id: 'news-agent', type: 'custom', position: { x: 280, y: 180 }, data: { label: 'News Agent', icon: <Newspaper size={18} />, description: 'FinBERT then optional LLM', category: 'agent', status: 'IDLE', hoverRows: hoverRows('news-agent', undefined, []) } },
    { id: 'fundamental-agent', type: 'custom', position: { x: 520, y: 180 }, data: { label: 'Fundamental Agent', icon: <Activity size={18} />, description: 'AlphaVantage + AIRouter', category: 'agent', status: 'IDLE', hoverRows: hoverRows('fundamental-agent', undefined, []) } },
    { id: 'macro-agent', type: 'custom', position: { x: 760, y: 180 }, data: { label: 'Macro Agent', icon: <Activity size={18} />, description: 'Macro series + AIRouter', category: 'agent', status: 'IDLE', hoverRows: hoverRows('macro-agent', undefined, []) } },
    { id: 'kronos-forecast', type: 'custom', position: { x: 1000, y: 180 }, data: { label: 'Kronos Forecaster', icon: <BrainCircuit size={18} />, description: 'Local Chronos (opt-in)', category: 'agent', status: 'IDLE', hoverRows: hoverRows('kronos-forecast', undefined, []) } },
    { id: 'portfolio-monitor', type: 'custom', position: { x: 1000, y: 320 }, data: { label: 'Portfolio Monitor', icon: <Clock size={18} />, description: 'Exit ideas via pipeline', category: 'agent', status: 'IDLE', hoverRows: hoverRows('portfolio-monitor', undefined, []) } },
    { id: 'finbert-model', type: 'custom', position: { x: 280, y: 320 }, data: { label: 'FinBERT', icon: <Cpu size={18} />, description: 'Local sentiment — $0', category: 'local-model', status: 'IDLE', hoverRows: hoverRows('finbert-model', undefined, []) } },
    { id: 'ollama-llm', type: 'custom', position: { x: 520, y: 320 }, data: { label: 'Ollama', icon: <Cpu size={18} />, description: 'Local OpenAI-compatible', category: 'local-model', status: 'IDLE', hoverRows: hoverRows('ollama-llm', undefined, []) } },
    { id: 'paid-llm-pool', type: 'custom', position: { x: 760, y: 320 }, data: { label: 'Paid AI Pool', icon: <DollarSign size={18} />, description: 'Gemini/OpenAI via AIRouter', category: 'paid-model', status: 'IDLE', hoverRows: hoverRows('paid-llm-pool', undefined, []) } },
    { id: 'chief-trader', type: 'custom', position: { x: 520, y: 470 }, data: { label: 'Chief Trader', icon: <UserCheck size={18} />, description: 'Weighted consensus', category: 'decision', status: 'IDLE', hoverRows: hoverRows('chief-trader', undefined, []) } },
    { id: 'risk-manager', type: 'custom', position: { x: 320, y: 620 }, data: { label: 'Risk Engine', icon: <ShieldCheck size={18} />, description: 'Fail-closed gates', category: 'risk', status: 'IDLE', hoverRows: hoverRows('risk-manager', undefined, []) } },
    { id: 'capital-guard', type: 'custom', position: { x: 720, y: 620 }, data: { label: 'Capital Guard', icon: <DollarSign size={18} />, description: 'settings.budget allocation', category: 'risk', status: 'IDLE', hoverRows: hoverRows('capital-guard', undefined, []) } },
    { id: 'order-management', type: 'custom', position: { x: 520, y: 760 }, data: { label: 'Order Execution', icon: <Send size={18} />, description: 'OMS → BrokerManager', category: 'execution', status: 'IDLE', hoverRows: hoverRows('order-management', undefined, []) } },
    { id: 'learning-engine', type: 'custom', position: { x: 1000, y: 760 }, data: { label: 'Reflection Engine', icon: <BookOpen size={18} />, description: 'Scored outcomes / rules', category: 'execution', status: 'IDLE', hoverRows: hoverRows('learning-engine', undefined, []) } },
  ], []);

  const initialEdges: Edge[] = useMemo(() => [
    { id: 'e-market-tech', source: 'market-data-worker', target: 'technical-engine', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-market-kronos', source: 'market-data-worker', target: 'kronos-forecast', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-news-src-agent', source: 'news-providers', target: 'news-agent', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-newsagent-finbert', source: 'news-agent', target: 'finbert-model', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-newsagent-ollama', source: 'news-agent', target: 'ollama-llm', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-agent-paidllm', source: 'news-agent', target: 'paid-llm-pool', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-tech-chief', source: 'technical-engine', target: 'chief-trader', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-quant-chief', source: 'quant-engine', target: 'chief-trader', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-news-chief', source: 'news-agent', target: 'chief-trader', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-fund-chief', source: 'fundamental-agent', target: 'chief-trader', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-macro-chief', source: 'macro-agent', target: 'chief-trader', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-kronos-chief', source: 'kronos-forecast', target: 'chief-trader', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-port-chief', source: 'portfolio-monitor', target: 'chief-trader', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-chief-risk', source: 'chief-trader', target: 'risk-manager', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-risk-capital', source: 'risk-manager', target: 'capital-guard', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-capital-exec', source: 'capital-guard', target: 'order-management', type: 'packet', data: { packets: [] }, style: idleEdge },
    { id: 'e-exec-learn', source: 'order-management', target: 'learning-engine', type: 'packet', data: { packets: [] }, style: idleEdge },
  ], []);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const snapshotsRef = useRef<Map<string, LastSnapshot>>(new Map());
  const weightsRef = useRef(weights);
  weightsRef.current = weights;

  const clearNodeLater = useCallback((nodeId: string, delay: number) => {
    const prev = nodeTimers.current.get(nodeId);
    if (prev) window.clearTimeout(prev);
    const tid = window.setTimeout(() => {
      setNodes((nds) => nds.map((n) => n.id === nodeId && n.data.status !== 'PROCESSING'
        ? { ...n, data: { ...n.data, status: 'IDLE' } }
        : n));
      nodeTimers.current.delete(nodeId);
    }, delay);
    nodeTimers.current.set(nodeId, tid);
  }, [setNodes]);

  const flushPending = useCallback(() => {
    rafRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = { snapshots: new Map(), pulses: new Map(), packets: [], events: [] };

    if (pending.events.length) {
      setEvents((prev) => {
        let next = [...pending.events, ...prev];
        if (pending.events.some((e) => e.type === 'MARKET_DATA')) {
          let keptTick = false;
          next = next.filter((e) => {
            if (e.type !== 'MARKET_DATA') return true;
            if (keptTick) return false;
            keptTick = true;
            return true;
          });
        }
        return next.slice(0, 150);
      });
    }

    if (pending.pulses.size === 0 && pending.packets.length === 0 && pending.snapshots.size === 0) return;

    for (const [nid, snap] of pending.snapshots) snapshotsRef.current.set(nid, snap);
    seqRef.current += 1;
    const pulseKey = seqRef.current;

    setNodes((nds) => nds.map((n) => {
      const st = pending.pulses.get(n.id);
      const snap = pending.snapshots.get(n.id) || snapshotsRef.current.get(n.id);
      if (st == null && !pending.snapshots.has(n.id)) return n;
      return {
        ...n,
        data: {
          ...n.data,
          status: st ?? n.data.status,
          pulseKey: st === 'PULSE' ? pulseKey : n.data.pulseKey,
          lastSnapshot: snap,
          hoverRows: hoverRows(n.id, snap, weightsRef.current),
        },
      };
    }));

    if (pending.packets.length) {
      const stamped = pending.packets.map((p) => {
        seqRef.current += 1;
        return { edgeId: p.edgeId, packet: { id: `pkt-${seqRef.current}`, color: p.color } };
      });
      setEdges((eds) => eds.map((e) => {
        const hit = stamped.filter((p) => p.edgeId === e.id);
        if (hit.length === 0) return e;
        return { ...e, data: { ...e.data, packets: [...(e.data?.packets || []), ...hit.map((h) => h.packet)] } };
      }));
      const tid = window.setTimeout(() => {
        const ids = new Set(stamped.map((s) => s.packet.id));
        setEdges((eds) => eds.map((e) => ({
          ...e,
          data: { ...e.data, packets: (e.data?.packets || []).filter((pk: Packet) => !ids.has(pk.id)) },
        })));
      }, PACKET_MS + 40);
      packetTimers.current.push(tid);
    }

    for (const [id, status] of pending.pulses) {
      if (status === 'PROCESSING') {
        const prev = nodeTimers.current.get(id);
        if (prev) window.clearTimeout(prev);
        nodeTimers.current.delete(id);
      } else {
        clearNodeLater(id, status === 'PULSE' ? PULSE_MS : FLASH_MS);
      }
    }
  }, [clearNodeLater, setEdges, setNodes]);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(flushPending);
  }, [flushPending]);

  const enqueueEvent = useCallback((type: string, data: any, visuals: {
    nodes?: { id: string; status: VisualStatus }[];
    packets?: { edgeId: string; color: string }[];
    skipLog?: boolean;
  }) => {
    seqRef.current += 1;
    const timestamp = data?.timestamp || new Date().toISOString();
    const snap: LastSnapshot = { eventType: type, timestamp, payload: data };
    if (!visuals.skipLog) {
      pendingRef.current.events.push({ id: `ev-${seqRef.current}`, type, timestamp, payload: data });
    }
    for (const n of visuals.nodes || []) {
      pendingRef.current.pulses.set(n.id, n.status);
      pendingRef.current.snapshots.set(n.id, snap);
    }
    if (visuals.packets) pendingRef.current.packets.push(...visuals.packets);
    scheduleFlush();
  }, [scheduleFlush]);

  const { subscribe, status: wsStatus } = useWebSocket();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v2/agents/learning-summary')
      .then((r) => r.json())
      .then((body) => {
        if (cancelled || !body?.ok || !Array.isArray(body.agentWeights)) return;
        setWeights(body.agentWeights);
      })
      .catch(() => { /* hover still shows last consensus payload */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isPlaying) return;

    const unsubs = [
      subscribe('MARKET_DATA', (data: any) => {
        const now = Date.now();
        const throttled = now - lastTickPulseRef.current < TICK_THROTTLE_MS;
        if (!throttled) lastTickPulseRef.current = now;
        enqueueEvent('MARKET_DATA', data, {
          skipLog: throttled,
          nodes: throttled ? [{ id: 'market-data-worker', status: 'PULSE' }] : [
            { id: 'market-data-worker', status: 'PULSE' },
            { id: 'technical-engine', status: 'PULSE' },
            { id: 'kronos-forecast', status: 'PULSE' },
          ],
          packets: throttled ? [] : MARKET_FANOUT_EDGES.map((edgeId) => ({ edgeId, color: '#22d3ee' })),
        });
      }),
      subscribe('NEWS_ANALYSIS_STARTED', (data: any) => enqueueEvent('NEWS_ANALYSIS_STARTED', data, {
        nodes: [{ id: 'news-providers', status: 'PROCESSING' }, { id: 'news-agent', status: 'PROCESSING' }],
        packets: [{ edgeId: 'e-news-src-agent', color: '#a78bfa' }],
      })),
      subscribe('NEWS_ANALYZED', (data: any) => enqueueEvent('NEWS_ANALYZED', data, {
        nodes: [
          { id: 'news-providers', status: 'SUCCESS' },
          { id: 'news-agent', status: 'SUCCESS' },
          ...(data?.impact?.sentimentSource === 'finbert' ? [{ id: 'finbert-model', status: 'SUCCESS' as VisualStatus }] : []),
        ],
        packets: data?.impact?.sentimentSource === 'finbert' ? [{ edgeId: 'e-newsagent-finbert', color: '#34d399' }] : [],
      })),
      subscribe('ESCALATION_DECISION', (data: any) => enqueueEvent('ESCALATION_DECISION', data, {
        nodes: [
          { id: 'news-agent', status: 'PULSE' },
          { id: 'finbert-model', status: data?.escalated ? 'PROCESSING' : 'SUCCESS' },
          ...(data?.escalated ? [{ id: 'ollama-llm', status: 'PROCESSING' as VisualStatus }] : []),
        ],
        packets: data?.escalated ? [{ edgeId: 'e-newsagent-ollama', color: '#fbbf24' }] : [{ edgeId: 'e-newsagent-finbert', color: '#34d399' }],
      })),
      subscribe('UI_UPDATE', (data: any) => {
        if (data?.type !== 'ai_metrics_update') return;
        const payload = data.payload || {};
        const ok = payload.success !== false;
        const modelNode = payload.local ? 'ollama-llm' : 'paid-llm-pool';
        const agentNode = AGENT_NODE[payload.agent];
        enqueueEvent('AI_METRICS_UPDATE', payload, {
          nodes: [
            { id: modelNode, status: ok ? 'SUCCESS' : 'FAIL' },
            ...(agentNode ? [{ id: agentNode, status: 'PULSE' as VisualStatus }] : []),
          ],
          packets: [{ edgeId: payload.local ? 'e-newsagent-ollama' : 'e-agent-paidllm', color: ok ? '#34d399' : '#fb7185' }],
        });
      }),
      subscribe('TECHNICAL_ANALYSIS_STARTED', (data: any) => enqueueEvent('TECHNICAL_ANALYSIS_STARTED', data, {
        nodes: [{ id: 'technical-engine', status: 'PROCESSING' }],
        packets: [{ edgeId: 'e-market-tech', color: '#22d3ee' }],
      })),
      subscribe('TECHNICAL_ANALYSIS_COMPLETED', (data: any) => enqueueEvent('TECHNICAL_ANALYSIS_COMPLETED', data, {
        nodes: [{ id: 'technical-engine', status: 'SUCCESS' }],
      })),
      subscribe('TRADE_IDEA_GENERATED', (data: any) => {
        const node = AGENT_NODE[data?.agent];
        const edgeId = node ? NODE_TO_CHIEF_EDGE[node] : undefined;
        enqueueEvent('TRADE_IDEA_GENERATED', data, {
          nodes: [
            ...(node ? [{ id: node, status: 'PULSE' as VisualStatus }] : []),
            { id: 'chief-trader', status: 'PROCESSING' },
          ],
          packets: edgeId ? [{ edgeId, color: '#c084fc' }] : [],
        });
      }),
      subscribe('CHIEF_CONSENSUS_STARTED', (data: any) => enqueueEvent('CHIEF_CONSENSUS_STARTED', data, {
        nodes: [{ id: 'chief-trader', status: 'PROCESSING' }, { id: 'paid-llm-pool', status: 'PROCESSING' }],
      })),
      subscribe('CHIEF_CONSENSUS_COMPLETED', (data: any) => enqueueEvent('CHIEF_CONSENSUS_COMPLETED', data, {
        nodes: [
          { id: 'chief-trader', status: data?.approved ? 'SUCCESS' : 'FAIL' },
          { id: 'paid-llm-pool', status: 'SUCCESS' },
        ],
      })),
      subscribe('CHIEF_APPROVED_IDEA', (data: any) => enqueueEvent('CHIEF_APPROVED_IDEA', data, {
        nodes: [{ id: 'chief-trader', status: 'SUCCESS' }, { id: 'risk-manager', status: 'PROCESSING' }],
        packets: [{ edgeId: 'e-chief-risk', color: '#fbbf24' }],
      })),
      subscribe('RISK_ASSESSMENT_STARTED', (data: any) => enqueueEvent('RISK_ASSESSMENT_STARTED', data, {
        nodes: [{ id: 'risk-manager', status: 'PROCESSING' }],
      })),
      subscribe('RISK_GATE_EVALUATED', (data: any) => enqueueEvent('RISK_GATE_EVALUATED', data, {
        nodes: [{ id: 'risk-manager', status: 'PULSE' }],
      })),
      subscribe('RISK_ASSESSMENT_COMPLETED', (data: any) => enqueueEvent('RISK_ASSESSMENT_COMPLETED', data, {
        nodes: [
          { id: 'risk-manager', status: data?.approved ? 'SUCCESS' : 'FAIL' },
          ...(data?.approved ? [{ id: 'order-management', status: 'PROCESSING' as VisualStatus }] : []),
        ],
        packets: data?.approved
          ? [{ edgeId: 'e-risk-capital', color: '#34d399' }, { edgeId: 'e-capital-exec', color: '#34d399' }]
          : [],
      })),
      subscribe('ORDER_SUBMITTED', (data: any) => enqueueEvent('ORDER_SUBMITTED', data, {
        nodes: [{ id: 'order-management', status: 'PROCESSING' }],
        packets: [{ edgeId: 'e-capital-exec', color: '#2dd4bf' }],
      })),
      subscribe('ORDER_ACCEPTED', (data: any) => enqueueEvent('ORDER_ACCEPTED', data, {
        nodes: [{ id: 'order-management', status: 'PULSE' }],
      })),
      subscribe('ORDER_FILLED', (data: any) => enqueueEvent('ORDER_FILLED', data, {
        nodes: [{ id: 'order-management', status: 'SUCCESS' }],
      })),
      subscribe('ORDER_EXECUTED', (data: any) => enqueueEvent('ORDER_EXECUTED', data, {
        nodes: [{ id: 'order-management', status: 'SUCCESS' }, { id: 'learning-engine', status: 'PULSE' }],
        packets: [{ edgeId: 'e-exec-learn', color: '#2dd4bf' }],
      })),
      subscribe('LEARNED_NEW_RULE', (data: any) => enqueueEvent('LEARNED_NEW_RULE', data, {
        nodes: [{ id: 'learning-engine', status: 'SUCCESS' }],
      })),
      subscribe('CAPITAL_CHECK', (data: any) => enqueueEvent('CAPITAL_CHECK', data, {
        nodes: [{ id: 'capital-guard', status: data?.passed ? 'SUCCESS' : 'FAIL' }],
        packets: [{ edgeId: 'e-risk-capital', color: data?.passed ? '#fbbf24' : '#fb7185' }],
      })),
      subscribe('AGENT_DISAGREEMENT', (data: any) => enqueueEvent('AGENT_DISAGREEMENT', data, {
        nodes: [{ id: 'chief-trader', status: 'PULSE' }],
      })),
      subscribe(eventCatalog.POSITION_MONITORED, (data: any) => enqueueEvent(eventCatalog.POSITION_MONITORED, data, {
        nodes: [{ id: 'portfolio-monitor', status: 'PULSE' }],
      })),
      subscribe(eventCatalog.POSITION_RISK_CHANGED, (data: any) => enqueueEvent(eventCatalog.POSITION_RISK_CHANGED, data, {
        nodes: [{ id: 'portfolio-monitor', status: 'FAIL' }],
        packets: [{ edgeId: 'e-port-chief', color: '#fb7185' }],
      })),
      subscribe('MODEL_HEALTH', (data: any) => {
        const ok = data?.ok !== false && data?.reachable !== false;
        const id = data?.modelId === 'ollama' ? 'ollama-llm' : data?.modelId === 'chronos-kronos' || data?.modelId === 'chronos' ? 'kronos-forecast' : null;
        if (!id) return;
        enqueueEvent('MODEL_HEALTH', data, { nodes: [{ id, status: ok ? 'SUCCESS' : 'FAIL' }] });
      }),
      subscribe('MODEL_STARTED', (data: any) => {
        const id = data?.modelId === 'ollama' ? 'ollama-llm' : data?.modelId === 'chronos' ? 'kronos-forecast' : null;
        if (!id) return;
        enqueueEvent('MODEL_STARTED', data, { nodes: [{ id, status: 'PROCESSING' }] });
      }),
      subscribe('MODEL_UNAVAILABLE', (data: any) => enqueueEvent('MODEL_UNAVAILABLE', data, {
        nodes: [{ id: 'paid-llm-pool', status: 'FAIL' }, { id: 'ollama-llm', status: 'FAIL' }],
      })),
      subscribe('MODEL_FALLBACK', (data: any) => enqueueEvent('MODEL_FALLBACK', data, {
        nodes: [{ id: 'paid-llm-pool', status: 'FAIL' }, { id: 'ollama-llm', status: 'PROCESSING' }],
      })),
    ];

    return () => {
      unsubs.forEach((u) => u());
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      nodeTimers.current.forEach((tid) => window.clearTimeout(tid));
      nodeTimers.current.clear();
      packetTimers.current.forEach((tid) => window.clearTimeout(tid));
      packetTimers.current = [];
    };
  }, [enqueueEvent, isPlaying, subscribe]);

  const transactions = useMemo(() => buildTransactions(events), [events]);
  const selectedTx = transactions.find((t) => t.traceId === selectedTraceId) || null;

  return (
    <div className="flex flex-col h-[800px] gap-4">
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Layers size={20} className="text-cyan-400" />
            Agent Network — Live Telemetry
          </h2>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            Packets and glows fire only on real EventBus WebSocket events. Idle tape = idle graph. WS {wsStatus}.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden md:flex gap-3 text-[9px] font-mono uppercase tracking-wider text-slate-500">
            <span className="text-cyan-300">cyan tick</span>
            <span className="text-violet-300">idea</span>
            <span className="text-amber-300">chief→risk</span>
            <span className="text-emerald-300">ok</span>
            <span className="text-rose-300">fail</span>
          </div>
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-[10px] font-bold tracking-widest uppercase transition-colors ${isPlaying ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-400'}`}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            {isPlaying ? 'LIVE STREAMING' : 'PAUSED'}
          </button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 flex-1 h-full">
        <div className="flex-1 border border-slate-800 rounded-lg bg-[#0A0F16] relative overflow-hidden h-[600px] lg:h-full">
          <motion.div
            className="h-full w-full"
            animate={{
              filter: selectedNodeId ? 'blur(8px)' : 'blur(0px)',
              opacity: selectedNodeId ? 0.38 : 1,
            }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            style={{ pointerEvents: selectedNodeId ? 'none' : 'auto' }}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              className="bg-slate-950"
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#1e293b" gap={20} size={1} />
              <Controls className="bg-slate-900 border-slate-800 fill-slate-400" />
            </ReactFlow>
          </motion.div>
          <AnimatePresence>
            {selectedNodeId && (
              <AgentFocusMode
                key={selectedNodeId}
                nodeId={selectedNodeId}
                nodeLabel={String(nodes.find((n) => n.id === selectedNodeId)?.data?.label || selectedNodeId)}
                seedEvents={events}
                weights={weights}
                onClose={() => setSelectedNodeId(null)}
              />
            )}
          </AnimatePresence>
        </div>

        <div className="w-full lg:w-[420px] bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex flex-col h-[600px] lg:h-full overflow-hidden">
          <div className="flex items-center justify-between mb-3 border-b border-slate-800 pb-2">
            <div className="flex gap-1 bg-[#0A0F16] p-1 rounded-md">
              <button onClick={() => setPanelTab('transactions')} className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${panelTab === 'transactions' ? 'bg-cyan-700 text-white' : 'text-slate-500'}`}>
                <Hash size={10} className="inline mr-1" />Transactions
              </button>
              <button onClick={() => setPanelTab('raw')} className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${panelTab === 'raw' ? 'bg-cyan-700 text-white' : 'text-slate-500'}`}>
                <Terminal size={10} className="inline mr-1" />Raw Events
              </button>
            </div>
            {isPlaying && wsStatus === 'connected' && <span className="w-2 h-2 rounded-full bg-emerald-500" />}
          </div>

          {panelTab === 'transactions' ? (
            <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar pr-1">
              {transactions.map((tx) => {
                const badge = STATUS_BADGE[tx.status];
                return (
                  <motion.div
                    key={tx.traceId}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={() => setSelectedTraceId(tx.traceId)}
                    className={`bg-[#0A0F16] border rounded p-3 text-[10px] cursor-pointer transition-colors ${selectedTraceId === tx.traceId ? 'border-cyan-500' : 'border-slate-800 hover:border-slate-700'}`}
                  >
                    <div className="flex justify-between items-center mb-1.5">
                      <span className="font-mono text-slate-500 flex items-center gap-1"><Hash size={9} />{tx.traceId}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold border ${badge.cls}`}>{badge.label}</span>
                    </div>
                    <div className="flex justify-between items-center text-slate-300">
                      <span className="font-bold">{tx.symbol || '—'}</span>
                      <span className="text-slate-500">{tx.originAgent}</span>
                    </div>
                    <div className="flex gap-1 mt-2">
                      {STAGE_ORDER.map((stage) => {
                        const reached = tx.stages.some((s) => s.type === stage);
                        return <div key={stage} className={`h-1 flex-1 rounded-full ${reached ? 'bg-cyan-500' : 'bg-slate-800'}`} />;
                      })}
                    </div>
                    <div className="text-[8px] text-slate-600 mt-1 text-right">{new Date(tx.lastUpdate).toLocaleTimeString()}</div>
                  </motion.div>
                );
              })}
              {transactions.length === 0 && (
                <div className="text-center text-slate-600 font-mono text-[10px] mt-10 italic">Awaiting the first TRADE_IDEA_GENERATED…</div>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar pr-2">
              {events.map((evt) => (
                <div
                  key={evt.id}
                  onClick={() => setSelectedEvent(evt)}
                  className="bg-[#0A0F16] border border-slate-800 rounded p-3 text-[10px] cursor-pointer hover:border-cyan-500 transition-colors"
                >
                  <div className="flex justify-between items-center mb-2 pb-1 border-b border-slate-800/50">
                    <span className="font-bold text-cyan-400 font-mono flex items-center gap-1">
                      <Terminal size={10} /> {evt.type}
                    </span>
                    <span className="text-slate-600 text-[9px]">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-slate-300 font-mono text-[9px] leading-relaxed truncate">
                    {evt.type === 'MARKET_DATA' ? `${evt.payload?.symbol} @ ${evt.payload?.price}` : JSON.stringify(evt.payload).slice(0, 180)}
                  </div>
                </div>
              ))}
              {events.length === 0 && (
                <div className="text-center text-slate-600 font-mono text-[10px] mt-10 italic">Awaiting events…</div>
              )}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {selectedTx && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
            onClick={() => setSelectedTraceId(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-[#1A1F2B] border border-slate-700 rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
            >
              <div className="flex justify-between items-center p-4 border-b border-slate-800">
                <h3 className="text-cyan-400 font-mono font-bold tracking-wider flex items-center gap-2">
                  <Hash size={16} /> Transaction {selectedTx.traceId}
                </h3>
                <button onClick={() => setSelectedTraceId(null)} className="text-slate-400 hover:text-white bg-slate-800 p-1 rounded">
                  <X size={16} />
                </button>
              </div>
              <div className="p-6 overflow-y-auto space-y-4">
                <p className="text-[10px] text-slate-500 font-mono">Replay uses this trace&apos;s real persisted stages only.</p>
                {selectedTx.stages.map((stage, i) => (
                  <div key={`${stage.type}-${i}`} className="relative pl-6">
                    {i < selectedTx.stages.length - 1 && <div className="absolute left-[5px] top-4 bottom-[-16px] w-px bg-slate-700" />}
                    <div className="absolute left-0 top-1 w-2.5 h-2.5 rounded-full bg-cyan-500" />
                    <div className="text-[10px] text-slate-500 font-mono mb-1">{new Date(stage.timestamp).toLocaleTimeString()} · {stage.type}</div>
                    <pre className="bg-[#0A0F16] p-3 rounded border border-slate-800 text-[10px] text-emerald-400 font-mono whitespace-pre-wrap">
                      {JSON.stringify(stage.payload, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {selectedEvent && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-[#1A1F2B] border border-slate-700 rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center p-4 border-b border-slate-800">
              <h3 className="text-cyan-400 font-mono font-bold tracking-wider flex items-center gap-2">
                <Activity size={16} /> Event Inspection: {selectedEvent.type}
              </h3>
              <button onClick={() => setSelectedEvent(null)} className="text-slate-400 hover:text-white bg-slate-800 p-1 rounded">
                <X size={16} />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <pre className="bg-[#0A0F16] p-4 rounded border border-slate-800 text-[11px] text-emerald-400 font-mono whitespace-pre-wrap">
                {JSON.stringify(selectedEvent.payload, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
