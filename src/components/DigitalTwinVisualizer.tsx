/**
 * ==========================================================
 * Module:
 * DigitalTwinVisualizer.tsx
 *
 * Purpose:
 * Real-time animated visualization of the actual autonomous pipeline: market data, news
 * ingestion, every agent, every local/paid AI model call, consensus, risk, and execution. Every
 * node/edge activation below is driven by a real WebSocket event from EventBus's wildcard
 * listener - there is no synthetic/demo data path. Node/edge lists were extended to cover
 * models and news ingestion that previously had no representation here, and a real bug was
 * fixed: the Market Data node subscribed to nothing, so it could never actually light up.
 *
 * Responsibilities:
 * - Subscribe to real backend events and derive node/edge activity from real recency.
 * - Group events that share a real traceId into an inspectable "Transaction" - the same id
 *   threaded through TRADE_IDEA_GENERATED -> CHIEF_APPROVED_IDEA -> RISK_ASSESSMENT_COMPLETED
 *   -> ORDER_EXECUTED on the backend.
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 * - Fabricate an activation that didn't come from a real event
 *
 * ==========================================================
 */

import { useWebSocket } from '../context/WebSocketContext';
import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import ReactFlow, {
  Controls, Background, useNodesState, useEdgesState,
  Handle, Position, Edge, Node
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  Activity, Newspaper, Clock, BookOpen, Terminal,
  BrainCircuit, TrendingUp, Layers, ShieldCheck, UserCheck, Send, Info, X, Pause, Play,
  Cpu, DollarSign, Zap, Hash
} from 'lucide-react';
import NodeInspectionPanel from './NodeInspectionPanel';

type NodeCategory = 'source' | 'agent' | 'local-model' | 'paid-model' | 'decision' | 'risk' | 'execution';

const CATEGORY_STYLE: Record<NodeCategory, { border: string; glow: string; iconBg: string; iconText: string }> = {
  source: { border: 'border-sky-800', glow: 'rgba(56,189,248,0.45)', iconBg: 'bg-sky-500/20', iconText: 'text-sky-400' },
  agent: { border: 'border-indigo-800', glow: 'rgba(99,102,241,0.45)', iconBg: 'bg-indigo-500/20', iconText: 'text-indigo-400' },
  'local-model': { border: 'border-emerald-800', glow: 'rgba(16,185,129,0.5)', iconBg: 'bg-emerald-500/20', iconText: 'text-emerald-400' },
  'paid-model': { border: 'border-amber-800', glow: 'rgba(245,158,11,0.45)', iconBg: 'bg-amber-500/20', iconText: 'text-amber-400' },
  decision: { border: 'border-fuchsia-800', glow: 'rgba(232,121,249,0.45)', iconBg: 'bg-fuchsia-500/20', iconText: 'text-fuchsia-400' },
  risk: { border: 'border-rose-800', glow: 'rgba(244,63,94,0.45)', iconBg: 'bg-rose-500/20', iconText: 'text-rose-400' },
  execution: { border: 'border-teal-800', glow: 'rgba(45,212,191,0.45)', iconBg: 'bg-teal-500/20', iconText: 'text-teal-400' },
};

const CustomNode = ({ data }: any) => {
  const style = CATEGORY_STYLE[data.category as NodeCategory] || CATEGORY_STYLE.agent;
  const active = data.status === 'ACTIVE';
  return (
    <div className="relative">
      {active && (
        <motion.div
          className="absolute inset-0 rounded-xl"
          initial={{ opacity: 0.6, scale: 1 }}
          animate={{ opacity: 0, scale: 1.35 }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeOut' }}
          style={{ boxShadow: `0 0 0 2px ${style.glow}`, background: style.glow }}
        />
      )}
      <div
        className={`relative px-4 py-3 w-52 shadow-lg rounded-xl bg-[#0A0F16] border-2 transition-all duration-300 ${active ? `${style.border} scale-105` : 'border-slate-800'}`}
        style={active ? { boxShadow: `0 0 22px ${style.glow}` } : undefined}
      >
        <Handle type="target" position={Position.Top} className="w-2 h-2 bg-slate-500 border-none" />
        <div className="flex items-center gap-3">
          <div className={`rounded-lg p-2.5 transition-colors ${active ? style.iconBg + ' ' + style.iconText : 'bg-slate-800 text-slate-500'}`}>
            {data.icon}
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-bold text-white uppercase tracking-widest leading-tight truncate">{data.label}</div>
            <div className="text-[8px] text-slate-400 mt-0.5">{data.description}</div>
            {data.badge && (
              <div className={`text-[8px] mt-1 font-mono ${active ? style.iconText : 'text-slate-600'}`}>{data.badge}</div>
            )}
          </div>
        </div>
        <Handle type="source" position={Position.Bottom} className="w-2 h-2 bg-slate-500 border-none" />
      </div>
    </div>
  );
};

const nodeTypes = { custom: CustomNode };

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

const STAGE_ORDER = ['TRADE_IDEA_GENERATED', 'CHIEF_APPROVED_IDEA', 'RISK_ASSESSMENT_COMPLETED', 'ORDER_EXECUTED'];

function buildTransactions(evts: any[]): Transaction[] {
  const byTrace = new Map<string, Transaction>();
  // Oldest-first so stages accumulate in real chronological order.
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

export default function DigitalTwinVisualizer() {
  const [events, setEvents] = useState<any[]>([]);
  const [activeNodes, setActiveNodes] = useState<Set<string>>(new Set());
  const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<any>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [panelTab, setPanelTab] = useState<'transactions' | 'raw'>('transactions');
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const initialNodes: Node[] = [
    { id: 'market-data-worker', type: 'custom', position: { x: 20, y: 40 }, data: { label: 'Market Data', icon: <Activity size={18} />, description: 'Alpaca WS - live ticks', category: 'source', status: 'IDLE' } },
    { id: 'news-providers', type: 'custom', position: { x: 260, y: 40 }, data: { label: 'News Providers', icon: <Newspaper size={18} />, description: '7 real RSS/API feeds', category: 'source', status: 'IDLE' } },

    { id: 'technical-engine', type: 'custom', position: { x: 20, y: 180 }, data: { label: 'Technical Agent', icon: <TrendingUp size={18} />, description: 'RSI/MACD/BB - deterministic', category: 'agent', status: 'IDLE' } },
    { id: 'quant-engine', type: 'custom', position: { x: 20, y: 320 }, data: { label: 'Advanced Quant', icon: <Activity size={18} />, description: 'Multi-TF, volatility', category: 'agent', status: 'IDLE' } },
    { id: 'news-agent', type: 'custom', position: { x: 260, y: 180 }, data: { label: 'News Agent', icon: <Newspaper size={18} />, description: 'Sentiment -> trade idea', category: 'agent', status: 'IDLE' } },
    { id: 'fundamental-agent', type: 'custom', position: { x: 470, y: 180 }, data: { label: 'Fundamental Agent', icon: <Activity size={18} />, description: 'P/E, EPS growth', category: 'agent', status: 'IDLE' } },
    { id: 'macro-agent', type: 'custom', position: { x: 680, y: 180 }, data: { label: 'Macro Agent', icon: <Activity size={18} />, description: 'CPI, rates, unemployment', category: 'agent', status: 'IDLE' } },
    { id: 'kronos-forecast', type: 'custom', position: { x: 890, y: 180 }, data: { label: 'Kronos Forecaster', icon: <BrainCircuit size={18} />, description: 'Local Chronos forecast', category: 'agent', status: 'IDLE' } },
    { id: 'portfolio-monitor', type: 'custom', position: { x: 890, y: 320 }, data: { label: 'Portfolio Manager', icon: <Clock size={18} />, description: 'Position exit checks', category: 'agent', status: 'IDLE' } },

    { id: 'finbert-model', type: 'custom', position: { x: 260, y: 320 }, data: { label: 'FinBERT', icon: <Cpu size={18} />, description: 'Local sentiment model - $0', category: 'local-model', status: 'IDLE' } },
    { id: 'ollama-llm', type: 'custom', position: { x: 470, y: 320 }, data: { label: 'Ollama (llama3.2)', icon: <Cpu size={18} />, description: 'Local reasoning - $0', category: 'local-model', status: 'IDLE' } },
    { id: 'paid-llm-pool', type: 'custom', position: { x: 680, y: 320 }, data: { label: 'Paid AI Pool', icon: <DollarSign size={18} />, description: 'Gemini/OpenAI/etc - metered', category: 'paid-model', status: 'IDLE' } },

    { id: 'chief-trader', type: 'custom', position: { x: 470, y: 470 }, data: { label: 'Chief Trader', icon: <UserCheck size={18} />, description: 'Weighted evidence consensus', category: 'decision', status: 'IDLE' } },
    { id: 'risk-manager', type: 'custom', position: { x: 470, y: 610 }, data: { label: 'Risk Engine', icon: <ShieldCheck size={18} />, description: '9 real safety gates', category: 'risk', status: 'IDLE' } },
    { id: 'order-management', type: 'custom', position: { x: 470, y: 750 }, data: { label: 'Order Execution', icon: <Send size={18} />, description: 'Broker routing + fills', category: 'execution', status: 'IDLE' } },
    { id: 'learning-engine', type: 'custom', position: { x: 890, y: 750 }, data: { label: 'Reflection Engine', icon: <BookOpen size={18} />, description: 'Post-trade learning', category: 'execution', status: 'IDLE' } },
  ];

  const edgeStyle = { stroke: '#334155', strokeWidth: 2 };
  const initialEdges: Edge[] = [
    { id: 'e-market-tech', source: 'market-data-worker', target: 'technical-engine', style: edgeStyle },
    { id: 'e-market-quant', source: 'market-data-worker', target: 'quant-engine', style: edgeStyle },
    { id: 'e-news-src-agent', source: 'news-providers', target: 'news-agent', style: edgeStyle },
    { id: 'e-newsagent-finbert', source: 'news-agent', target: 'finbert-model', style: edgeStyle },
    { id: 'e-newsagent-ollama', source: 'news-agent', target: 'ollama-llm', style: edgeStyle },
    { id: 'e-agent-paidllm', source: 'news-agent', target: 'paid-llm-pool', style: edgeStyle },

    { id: 'e-tech-chief', source: 'technical-engine', target: 'chief-trader', style: edgeStyle },
    { id: 'e-quant-chief', source: 'quant-engine', target: 'chief-trader', style: edgeStyle },
    { id: 'e-news-chief', source: 'news-agent', target: 'chief-trader', style: edgeStyle },
    { id: 'e-fund-chief', source: 'fundamental-agent', target: 'chief-trader', style: edgeStyle },
    { id: 'e-macro-chief', source: 'macro-agent', target: 'chief-trader', style: edgeStyle },
    { id: 'e-kronos-chief', source: 'kronos-forecast', target: 'chief-trader', style: edgeStyle },
    { id: 'e-port-chief', source: 'portfolio-monitor', target: 'chief-trader', style: edgeStyle },

    { id: 'e-chief-risk', source: 'chief-trader', target: 'risk-manager', style: edgeStyle },
    { id: 'e-risk-exec', source: 'risk-manager', target: 'order-management', style: edgeStyle },
    { id: 'e-exec-learn', source: 'order-management', target: 'learning-engine', style: edgeStyle },
  ];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const { subscribe } = useWebSocket();
  useEffect(() => {
    if (!isPlaying) return;

    const record = (type: string) => (data: any) => {
      const newEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type,
        timestamp: new Date().toISOString(),
        payload: data,
      };
      setEvents(prev => {
        const updated = [newEvent, ...prev].slice(0, 150);
        updateGraphFromEvents(updated);
        return updated;
      });
    };

    const unsubs = [
      subscribe('MARKET_DATA', record('MARKET_DATA')),
      subscribe('NEWS_ANALYZED', record('NEWS_ANALYZED')),
      subscribe('ESCALATION_DECISION', record('ESCALATION_DECISION')),
      subscribe('UI_UPDATE', (data: any) => { if (data?.type === 'ai_metrics_update') record('AI_METRICS_UPDATE')(data.payload); }),
      subscribe('TRADE_IDEA_GENERATED', record('TRADE_IDEA_GENERATED')),
      subscribe('CHIEF_APPROVED_IDEA', record('CHIEF_APPROVED_IDEA')),
      subscribe('RISK_ASSESSMENT_COMPLETED', record('RISK_ASSESSMENT_COMPLETED')),
      subscribe('ORDER_EXECUTED', record('ORDER_EXECUTED')),
      subscribe('LEARNED_NEW_RULE', record('LEARNED_NEW_RULE')),
    ];

    return () => unsubs.forEach(u => u());
  }, [isPlaying, subscribe]);

  const updateGraphFromEvents = (latestEvents: any[]) => {
    const now = Date.now();
    const recent = latestEvents.filter(e => (now - new Date(e.timestamp).getTime()) < 3500);

    const newActiveNodes = new Set<string>();
    const newActiveEdges = new Set<string>();
    const AGENT_NODE: Record<string, string> = {
      TechnicalAgent: 'technical-engine', NewsAgent: 'news-agent', FundamentalAgent: 'fundamental-agent',
      MacroAgent: 'macro-agent', KronosEngine: 'kronos-forecast', PortfolioManager: 'portfolio-monitor',
    };
    // Explicit map, not derived from the node id string - "fundamental-agent" -> "e-fund-chief"
    // and "portfolio-monitor" -> "e-port-chief" don't share a prefix, so a split()-based guess
    // silently misses them.
    const NODE_TO_CHIEF_EDGE: Record<string, string> = {
      'technical-engine': 'e-tech-chief', 'news-agent': 'e-news-chief', 'fundamental-agent': 'e-fund-chief',
      'macro-agent': 'e-macro-chief', 'kronos-forecast': 'e-kronos-chief', 'portfolio-monitor': 'e-port-chief',
    };

    recent.forEach((evt) => {
      if (evt.type === 'MARKET_DATA') {
        newActiveNodes.add('market-data-worker');
        newActiveEdges.add('e-market-tech'); newActiveEdges.add('e-market-quant');
      } else if (evt.type === 'NEWS_ANALYZED') {
        newActiveNodes.add('news-providers'); newActiveNodes.add('news-agent');
        newActiveEdges.add('e-news-src-agent');
        if (evt.payload?.impact?.sentimentSource === 'finbert') {
          newActiveNodes.add('finbert-model'); newActiveEdges.add('e-newsagent-finbert');
        }
      } else if (evt.type === 'ESCALATION_DECISION') {
        newActiveNodes.add('news-agent'); newActiveNodes.add('finbert-model');
        newActiveEdges.add('e-newsagent-finbert');
        if (evt.payload?.escalated) { newActiveNodes.add('ollama-llm'); newActiveEdges.add('e-newsagent-ollama'); }
      } else if (evt.type === 'AI_METRICS_UPDATE') {
        const agentNode = AGENT_NODE[evt.payload?.agent] || 'news-agent';
        newActiveNodes.add(agentNode);
        if (evt.payload?.local) {
          newActiveNodes.add('ollama-llm'); newActiveEdges.add('e-newsagent-ollama');
        } else {
          newActiveNodes.add('paid-llm-pool'); newActiveEdges.add('e-agent-paidllm');
        }
      } else if (evt.type === 'TRADE_IDEA_GENERATED') {
        const node = AGENT_NODE[evt.payload.agent];
        if (node) { newActiveNodes.add(node); const edgeId = NODE_TO_CHIEF_EDGE[node]; if (edgeId) newActiveEdges.add(edgeId); }
        newActiveNodes.add('chief-trader');
      } else if (evt.type === 'CHIEF_APPROVED_IDEA') {
        newActiveNodes.add('chief-trader'); newActiveEdges.add('e-chief-risk'); newActiveNodes.add('risk-manager');
      } else if (evt.type === 'RISK_ASSESSMENT_COMPLETED') {
        newActiveNodes.add('risk-manager');
        if (evt.payload.approved) { newActiveEdges.add('e-risk-exec'); newActiveNodes.add('order-management'); }
      } else if (evt.type === 'ORDER_EXECUTED') {
        newActiveNodes.add('order-management'); newActiveEdges.add('e-exec-learn'); newActiveNodes.add('learning-engine');
      } else if (evt.type === 'LEARNED_NEW_RULE') {
        newActiveNodes.add('learning-engine');
      }
    });

    setActiveNodes(newActiveNodes);
    setActiveEdges(newActiveEdges);
  };

  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => ({ ...node, data: { ...node.data, status: activeNodes.has(node.id) ? 'ACTIVE' : 'IDLE' } }))
    );
    setEdges((eds) =>
      eds.map((edge) => ({
        ...edge,
        animated: activeEdges.has(edge.id),
        style: activeEdges.has(edge.id) ? { stroke: '#818cf8', strokeWidth: 3, opacity: 1 } : { stroke: '#334155', strokeWidth: 2, opacity: 0.5 },
      }))
    );
  }, [activeNodes, activeEdges, setNodes, setEdges]);

  const transactions = useMemo(() => buildTransactions(events), [events]);
  const selectedTx = transactions.find(t => t.traceId === selectedTraceId) || null;

  return (
    <div className="flex flex-col h-[800px] gap-4">
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Layers size={20} className="text-indigo-400" />
            Agent Network - Live
          </h2>
          <p className="text-xs text-slate-400 mt-1 font-mono">Real-time visualization of every agent, local/paid model call, and decision - driven by real WebSocket events, not a demo.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-[10px] font-bold tracking-widest uppercase transition-colors ${isPlaying ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            {isPlaying ? 'LIVE STREAMING' : 'PAUSED'}
          </button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 flex-1 h-full">
        <div className="flex-1 border border-slate-800 rounded-lg bg-[#0A0F16] relative overflow-hidden h-[600px] lg:h-full">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            nodeTypes={nodeTypes}
            fitView
            className="bg-slate-950"
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#1e293b" gap={20} size={2} />
            <Controls className="bg-slate-900 border-slate-800 fill-slate-400" />
          </ReactFlow>
          {selectedNodeId && (
            <NodeInspectionPanel nodeId={selectedNodeId} onClose={() => setSelectedNodeId(null)} activeEvents={events} />
          )}
        </div>

        {/* Live panel: real transactions (grouped by real traceId) or raw event stream */}
        <div className="w-full lg:w-[420px] bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex flex-col h-[600px] lg:h-full overflow-hidden">
          <div className="flex items-center justify-between mb-3 border-b border-slate-800 pb-2">
            <div className="flex gap-1 bg-[#0A0F16] p-1 rounded-md">
              <button onClick={() => setPanelTab('transactions')} className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${panelTab === 'transactions' ? 'bg-indigo-600 text-white' : 'text-slate-500'}`}>
                <Hash size={10} className="inline mr-1" />Transactions
              </button>
              <button onClick={() => setPanelTab('raw')} className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors ${panelTab === 'raw' ? 'bg-indigo-600 text-white' : 'text-slate-500'}`}>
                <Terminal size={10} className="inline mr-1" />Raw Events
              </button>
            </div>
            {isPlaying && <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.8)]"></span>}
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
                    className={`bg-[#0A0F16] border rounded p-3 text-[10px] cursor-pointer transition-colors ${selectedTraceId === tx.traceId ? 'border-indigo-500' : 'border-slate-800 hover:border-slate-700'}`}
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
                        const reached = tx.stages.some(s => s.type === stage);
                        return <div key={stage} className={`h-1 flex-1 rounded-full ${reached ? 'bg-indigo-500' : 'bg-slate-800'}`} />;
                      })}
                    </div>
                    <div className="text-[8px] text-slate-600 mt-1 text-right">{new Date(tx.lastUpdate).toLocaleTimeString()}</div>
                  </motion.div>
                );
              })}
              {transactions.length === 0 && (
                <div className="text-center text-slate-600 font-mono text-[10px] mt-10 italic">Awaiting the first trade idea...</div>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar pr-2">
              {events.map((evt) => (
                <div
                  key={evt.id}
                  onClick={() => setSelectedEvent(evt)}
                  className="bg-[#0A0F16] border border-slate-800 rounded p-3 text-[10px] cursor-pointer hover:border-indigo-500 transition-colors group"
                >
                  <div className="flex justify-between items-center mb-2 pb-1 border-b border-slate-800/50">
                    <span className="font-bold text-indigo-400 font-mono flex items-center gap-1">
                      <Terminal size={10} /> {evt.type}
                    </span>
                    <span className="text-slate-600 text-[9px]">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-slate-300 font-mono text-[9px] leading-relaxed">
                    {evt.type === 'MARKET_DATA' ? `Tick: ${evt.payload.symbol} @ $${evt.payload.price?.toFixed?.(2)} Vol: ${evt.payload.volume}` :
                      evt.type === 'NEWS_ANALYZED' ? `Category: ${evt.payload.category}\nSentiment source: ${evt.payload.impact?.sentimentSource}` :
                      evt.type === 'ESCALATION_DECISION' ? `${evt.payload.escalated ? 'ESCALATED' : 'LOCAL-FIRST (skipped LLM)'}\n${evt.payload.reason}` :
                      evt.type === 'AI_METRICS_UPDATE' ? `${evt.payload.providerName || evt.payload.provider} (${evt.payload.local ? 'local $0' : `$${evt.payload.cost?.toFixed?.(4)}`})\nAgent: ${evt.payload.agent} | ${evt.payload.latency}ms` :
                      evt.type === 'TRADE_IDEA_GENERATED' ? `Agent: ${evt.payload.agent}\nIdea: ${evt.payload.side} ${evt.payload.symbol}\nConf: ${(evt.payload.confidence * 100).toFixed(0)}%` :
                      evt.type === 'CHIEF_APPROVED_IDEA' ? `Chief Approved: ${evt.payload.side} ${evt.payload.symbol}\nContext: ${evt.payload.agentsContext}` :
                      evt.type === 'RISK_ASSESSMENT_COMPLETED' ? `Risk: ${evt.payload.approved ? 'PASS' : 'VETO'}\nSymbol: ${evt.payload.symbol}\nCap: ${evt.payload.maxQuantity} shares` :
                      evt.type === 'ORDER_EXECUTED' ? `Execution: ${evt.payload.side} ${evt.payload.quantity}x ${evt.payload.symbol}\nFill: $${evt.payload.price?.toFixed?.(2)}` :
                      JSON.stringify(evt.payload)
                    }
                  </div>
                </div>
              ))}
              {events.length === 0 && (
                <div className="text-center text-slate-600 font-mono text-[10px] mt-10 italic">Awaiting events...</div>
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
                <h3 className="text-indigo-400 font-mono font-bold tracking-wider flex items-center gap-2">
                  <Hash size={16} /> Transaction {selectedTx.traceId}
                </h3>
                <button onClick={() => setSelectedTraceId(null)} className="text-slate-400 hover:text-white bg-slate-800 p-1 rounded">
                  <X size={16} />
                </button>
              </div>
              <div className="p-6 overflow-y-auto space-y-4">
                {selectedTx.stages.map((stage, i) => (
                  <div key={i} className="relative pl-6">
                    {i < selectedTx.stages.length - 1 && <div className="absolute left-[5px] top-4 bottom-[-16px] w-px bg-slate-700" />}
                    <div className="absolute left-0 top-1 w-2.5 h-2.5 rounded-full bg-indigo-500" />
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
              <h3 className="text-indigo-400 font-mono font-bold tracking-wider flex items-center gap-2">
                <Activity size={16} /> Event Inspection: {selectedEvent.type}
              </h3>
              <button onClick={() => setSelectedEvent(null)} className="text-slate-400 hover:text-white bg-slate-800 p-1 rounded">
                <X size={16} />
              </button>
            </div>
            <div className="p-6 overflow-y-auto">
              <div className="mb-4">
                <h4 className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-2">Real Payload Data</h4>
                <pre className="bg-[#0A0F16] p-4 rounded border border-slate-800 text-[11px] text-emerald-400 font-mono whitespace-pre-wrap">
                  {JSON.stringify(selectedEvent.payload, null, 2)}
                </pre>
              </div>
              <div className="mt-4 flex justify-between items-center border-t border-slate-800 pt-4">
                <span className="text-[10px] text-slate-500 font-mono">Event ID: {selectedEvent.id}</span>
                <span className="text-[10px] text-slate-500 font-mono">Timestamp: {new Date(selectedEvent.timestamp).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
