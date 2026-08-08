/**
 * ==========================================================
 * Module:
 * AgentTopologyMap.tsx
 *
 * Purpose:
 * Core implementation and logic for the AgentTopologyMap.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AgentTopologyMapx
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import React, { useState, useCallback } from 'react';
import ReactFlow, {
  Controls,
  Background,
  applyNodeChanges,
  applyEdgeChanges,
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  BaseEdge,
  getBezierPath,
  EdgeProps
} from 'reactflow';
import 'reactflow/dist/style.css';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer
} from 'recharts';
import { 
  Activity, 
  X, 
  History, 
  TrendingUp, 
  TrendingDown,
  Cpu,
  Wifi,
  AlertTriangle,
  Gauge
} from 'lucide-react';
import { motion } from 'motion/react';

// Define the custom edge
const PulseEdge = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
}: EdgeProps) => {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const isFlowEnabled = data?.flowAnimationEnabled;

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      {isFlowEnabled && (
        <motion.circle
          r="4"
          fill="#38bdf8"
          animate={{
            offsetDistance: ["0%", "100%"]
          }}
          transition={{
            duration: 1.5,
            ease: "easeInOut",
            repeat: Infinity,
            repeatType: "loop"
          }}
          style={{ 
            filter: 'drop-shadow(0 0 6px #38bdf8)',
            offsetPath: `path('${edgePath}')` 
          } as any}
        />
      )}
    </>
  );
};

const edgeTypes = {
  pulse: PulseEdge,
};

const initialNodes: Node[] = [
  {
    id: 'news',
    position: { x: 50, y: 50 },
    data: { label: 'NewsAgent (NLP)', type: 'Analysis', sharpe: 1.8, winRate: 64, ping: '24ms' },
    style: { background: '#1e293b', color: '#fff', border: '1px solid #3b82f6', borderRadius: '8px', padding: '10px' },
  },
  {
    id: 'macro',
    position: { x: 50, y: 150 },
    data: { label: 'MacroAgent (Quant)', type: 'Analysis', sharpe: 2.1, winRate: 68, ping: '45ms' },
    style: { background: '#1e293b', color: '#fff', border: '1px solid #8b5cf6', borderRadius: '8px', padding: '10px' },
  },
  {
    id: 'technical',
    position: { x: 50, y: 250 },
    data: { label: 'TechnicalAgent (TA)', type: 'Analysis', sharpe: 1.4, winRate: 59, ping: '12ms' },
    style: { background: '#1e293b', color: '#fff', border: '1px solid #10b981', borderRadius: '8px', padding: '10px' },
  },
  {
    id: 'sentiment',
    position: { x: 50, y: 350 },
    data: { label: 'SentimentAgent', type: 'Analysis', sharpe: 1.6, winRate: 61, ping: '32ms' },
    style: { background: '#1e293b', color: '#fff', border: '1px solid #f59e0b', borderRadius: '8px', padding: '10px' },
  },
  {
    id: 'orderflow',
    position: { x: 50, y: 450 },
    data: { label: 'OrderFlowAgent (L2)', type: 'Analysis', sharpe: 2.3, winRate: 72, ping: '8ms' },
    style: { background: '#1e293b', color: '#fff', border: '1px solid #06b6d4', borderRadius: '8px', padding: '10px' },
  },
  {
    id: 'proposer',
    position: { x: 400, y: 250 },
    data: { label: 'Proposer Node (Aggregator)', type: 'Consensus', sharpe: 2.5, winRate: 75, ping: '55ms' },
    style: { background: '#1e293b', color: '#fff', border: '2px solid #6366f1', borderRadius: '8px', padding: '15px' },
  },
  {
    id: 'verifier',
    position: { x: 700, y: 250 },
    data: { label: 'RiskVerification Node', type: 'Validator', sharpe: 0, winRate: 98, ping: '110ms' },
    style: { background: '#1e293b', color: '#fff', border: '2px solid #ef4444', borderRadius: '8px', padding: '15px' },
  },
  {
    id: 'executor',
    position: { x: 1000, y: 250 },
    data: { label: 'Execution Node', type: 'Executor', sharpe: 0, winRate: 100, ping: '15ms' },
    style: { background: '#1e293b', color: '#fff', border: '2px solid #10b981', borderRadius: '8px', padding: '15px' },
  },
];

const initialEdges: Edge[] = [
  { id: 'e-news-prop', source: 'news', target: 'proposer', type: 'pulse', label: 'Weight 15%', style: { stroke: '#3b82f6' }, data: {} },
  { id: 'e-macro-prop', source: 'macro', target: 'proposer', type: 'pulse', label: 'Weight 30%', style: { stroke: '#8b5cf6' }, data: {} },
  { id: 'e-tech-prop', source: 'technical', target: 'proposer', type: 'pulse', label: 'Weight 35%', style: { stroke: '#10b981' }, data: {} },
  { id: 'e-sent-prop', source: 'sentiment', target: 'proposer', type: 'pulse', label: 'Weight 10%', style: { stroke: '#f59e0b' }, data: {} },
  { id: 'e-order-prop', source: 'orderflow', target: 'proposer', type: 'pulse', label: 'Weight 10%', style: { stroke: '#06b6d4' }, data: {} },
  { id: 'e-prop-verif', source: 'proposer', target: 'verifier', type: 'pulse', label: 'Candidate Signals', style: { stroke: '#6366f1', strokeWidth: 2 }, data: {} },
  { id: 'e-verif-exec', source: 'verifier', target: 'executor', type: 'pulse', label: 'Approved Trades', style: { stroke: '#ef4444', strokeWidth: 2 }, data: {} },
];

export interface DetailedAgentStats {
  id?: string;
  label: string;
  type: string;
  ping: string;
  sharpe: number;
  winRate: number;
  errorRate: number;
  errorCountLabel: string;
  throughput: number; 
  throughputHistory: { time: string; throughput: number }[];
  errorBreakdown: { category: string; value: number }[];
  votingHistory: {
    time: string;
    symbol: string;
    decision: string;
    weight: string;
    outcome: string;
    description: string;
  }[];
}

const customDetailedStats: Record<string, DetailedAgentStats> = {
  news: {
    id: 'news',
    label: 'NewsAgent (NLP Sentiment)',
    type: 'Analysis',
    ping: '24ms',
    sharpe: 1.8,
    winRate: 64,
    errorRate: 1.8,
    errorCountLabel: "12 / 1000 runs",
    throughput: 28,
    throughputHistory: [
      { time: "10m ago", throughput: 20 },
      { time: "8m ago", throughput: 24 },
      { time: "6m ago", throughput: 18 },
      { time: "4m ago", throughput: 22 },
      { time: "2m ago", throughput: 25 },
      { time: "Now", throughput: 28 }
    ],
    errorBreakdown: [
      { category: "LLM Parser", value: 7 },
      { category: "Timeout", value: 4 },
      { category: "Rate Limit", value: 1 }
    ],
    votingHistory: [
      { time: "05:42 AM", symbol: "TSLA", decision: "BUY", weight: "1.2x", outcome: "ACCEPTED", description: "Identified positive capex indicators within high-volume news channels." },
      { time: "05:10 AM", symbol: "AAPL", decision: "SELL", weight: "0.8x", outcome: "VETO_BY_RISK", description: "Sub-threshold growth matrix logs found in negative tech updates." },
      { time: "04:30 AM", symbol: "NVDA", decision: "BUY", weight: "1.5x", outcome: "ACCEPTED", description: "Detected hot earnings reports semantics with strong matching criteria." }
    ]
  },
  macro: {
    id: 'macro',
    label: 'MacroAgent (Global Quant)',
    type: 'Analysis',
    ping: '45ms',
    sharpe: 2.1,
    winRate: 68,
    errorRate: 0.8,
    errorCountLabel: "4 / 1000 runs",
    throughput: 12,
    throughputHistory: [
      { time: "10m ago", throughput: 8 },
      { time: "8m ago", throughput: 10 },
      { time: "6m ago", throughput: 7 },
      { time: "4m ago", throughput: 9 },
      { time: "2m ago", throughput: 11 },
      { time: "Now", throughput: 12 }
    ],
    errorBreakdown: [
      { category: "Query Fail", value: 2 },
      { category: "JSON Spec", value: 1 },
      { category: "Timeout", value: 1 }
    ],
    votingHistory: [
      { time: "05:39 AM", symbol: "SPY", decision: "BUY", weight: "2.0x", outcome: "ACCEPTED", description: "FOMC dot-plot alignment matches standard interest rate-cut probabilities." },
      { time: "04:55 AM", symbol: "QQQ", decision: "SELL", weight: "1.0x", outcome: "ACCEPTED", description: "CPI metrics indicate mild stagflation momentum pressure in technology stocks." }
    ]
  },
  technical: {
    id: 'technical',
    label: 'TechnicalAgent (Pattern TA)',
    type: 'Analysis',
    ping: '12ms',
    sharpe: 1.4,
    winRate: 59,
    errorRate: 1.2,
    errorCountLabel: "22 / 2000 runs",
    throughput: 68,
    throughputHistory: [
      { time: "10m ago", throughput: 55 },
      { time: "8m ago", throughput: 50 },
      { time: "6m ago", throughput: 62 },
      { time: "4m ago", throughput: 58 },
      { time: "2m ago", throughput: 60 },
      { time: "Now", throughput: 68 }
    ],
    errorBreakdown: [
      { category: "DB Latency", value: 14 },
      { category: "Timeout", value: 6 },
      { category: "Format Error", value: 2 }
    ],
    votingHistory: [
      { time: "05:41 AM", symbol: "NVDA", decision: "BUY", weight: "2.5x", outcome: "ACCEPTED", description: "Breakout through 50 EMA baseline with consistent daily average metrics." },
      { time: "05:15 AM", symbol: "AMD", decision: "BUY", weight: "1.5x", outcome: "ACCEPTED", description: "MACD double bullish crossover signal on standard 1-hour interval chart." }
    ]
  },
  sentiment: {
    id: 'sentiment',
    label: 'SentimentAgent',
    type: 'Analysis',
    ping: '32ms',
    sharpe: 1.6,
    winRate: 61,
    errorRate: 2.4,
    errorCountLabel: "36 / 1500 runs",
    throughput: 44,
    throughputHistory: [
      { time: "10m ago", throughput: 30 },
      { time: "8m ago", throughput: 35 },
      { time: "6m ago", throughput: 28 },
      { time: "4m ago", throughput: 40 },
      { time: "2m ago", throughput: 45 },
      { time: "Now", throughput: 44 }
    ],
    errorBreakdown: [
      { category: "API Exception", value: 18 },
      { category: "Scraper Fail", value: 12 },
      { category: "Parse Block", value: 6 }
    ],
    votingHistory: [
      { time: "05:38 AM", symbol: "COIN", decision: "BUY", weight: "1.0x", outcome: "ACCEPTED", description: "Social sentiment volume peaks on active institutional discussion indices." },
      { time: "04:12 AM", symbol: "MSTR", decision: "BUY", weight: "1.8x", outcome: "ACCEPTED", description: "Aggregated bullish narrative clustering exceeds standard standard-deviation guidelines." }
    ]
  },
  orderflow: {
    id: 'orderflow',
    label: 'OrderFlowAgent (L2 Depth)',
    type: 'Analysis',
    ping: '8ms',
    sharpe: 2.3,
    winRate: 72,
    errorRate: 0.1,
    errorCountLabel: "5 / 5000 runs",
    throughput: 165,
    throughputHistory: [
      { time: "10m ago", throughput: 130 },
      { time: "8m ago", throughput: 145 },
      { time: "6m ago", throughput: 142 },
      { time: "4m ago", throughput: 155 },
      { time: "2m ago", throughput: 160 },
      { time: "Now", throughput: 165 }
    ],
    errorBreakdown: [
      { category: "Buffer Limit", value: 2 },
      { category: "Timeout API", value: 2 },
      { category: "Sync Deserial", value: 1 }
    ],
    votingHistory: [
      { time: "05:43 AM", symbol: "TSLA", decision: "BUY", weight: "3.0x", outcome: "ACCEPTED", description: "Wholesale block order buy limit clusters verified above floor level support." },
      { time: "05:22 AM", symbol: "PLTR", decision: "BUY", weight: "2.0x", outcome: "ACCEPTED", description: "Dark pool buy limit sweepers processed near trading floor bounds." }
    ]
  },
  proposer: {
    id: 'proposer',
    label: 'Proposer Node (Swarm Core)',
    type: 'Consensus',
    ping: '55ms',
    sharpe: 2.5,
    winRate: 75,
    errorRate: 3.2,
    errorCountLabel: "16 / 500 runs",
    throughput: 5,
    throughputHistory: [
      { time: "10m ago", throughput: 3 },
      { time: "8m ago", throughput: 2 },
      { time: "6m ago", throughput: 4 },
      { time: "4m ago", throughput: 3 },
      { time: "2m ago", throughput: 5 },
      { time: "Now", throughput: 5 }
    ],
    errorBreakdown: [
      { category: "Agent Conflict", value: 9 },
      { category: "Quorum Delay", value: 5 },
      { category: "L1 Feed Failure", value: 2 }
    ],
    votingHistory: [
      { time: "05:44 AM", symbol: "TSLA", decision: "BUY", weight: "1.5x", outcome: "SENT_TO_RISK", description: "Swarm proposer compiled 4 positive analytic models. Action dispatched." },
      { time: "05:12 AM", symbol: "AAPL", decision: "SELL", weight: "1.0x", outcome: "SENT_TO_RISK", description: "Consensus matrix favors quick short structural transaction." }
    ]
  },
  verifier: {
    id: 'verifier',
    label: 'RiskVerification (Validator)',
    type: 'Validator',
    ping: '110ms',
    sharpe: 0,
    winRate: 98,
    errorRate: 0.0,
    errorCountLabel: "0 / 500 runs",
    throughput: 5,
    throughputHistory: [
      { time: "10m ago", throughput: 3 },
      { time: "8m ago", throughput: 2 },
      { time: "6m ago", throughput: 4 },
      { time: "4m ago", throughput: 3 },
      { time: "2m ago", throughput: 5 },
      { time: "Now", throughput: 5 }
    ],
    errorBreakdown: [
      { category: "Circuit Breach", value: 34 },
      { category: "Rule Block", value: 12 },
      { category: "API Check Error", value: 0 }
    ],
    votingHistory: [
      { time: "05:44 AM", symbol: "TSLA", decision: "APPROVE", weight: "1.0x", outcome: "SENT_TO_EXEC", description: "Risk validations satisfied. Sizing metrics match allocation limits." },
      { time: "05:13 AM", symbol: "AAPL", decision: "VETO", weight: "0.0x", outcome: "BLOCKED", description: "Exceeds standard sector capital limit rules. Short trade vetoed." }
    ]
  },
  executor: {
    id: 'executor',
    label: 'Execution Node (Broker)',
    type: 'Executor',
    ping: '15ms',
    sharpe: 0,
    winRate: 100,
    errorRate: 0.5,
    errorCountLabel: "1 / 200 runs",
    throughput: 2,
    throughputHistory: [
      { time: "10m ago", throughput: 1 },
      { time: "8m ago", throughput: 2 },
      { time: "6m ago", throughput: 1 },
      { time: "4m ago", throughput: 2 },
      { time: "2m ago", throughput: 2 },
      { time: "Now", throughput: 2 }
    ],
    errorBreakdown: [
      { category: "Broker Delay", value: 1 },
      { category: "Slippage Skip", value: 0 },
      { category: "Timeout API", value: 0 }
    ],
    votingHistory: [
      { time: "05:45 AM", symbol: "TSLA", decision: "EXECUTE", weight: "1.0x", outcome: "FILLED", description: "Target matching verified. Order filled successfully at $342.10." },
      { time: "05:25 AM", symbol: "NVDA", decision: "EXECUTE", weight: "1.5x", outcome: "FILLED", description: "Routed execution filled successfully with minimal slippage." }
    ]
  }
};

export interface StatusLogMessage {
  timestamp: string;
  level: "INFO" | "WARNING" | "CRITICAL";
  source: string;
  message: string;
}

const agentStatusLogs: Record<string, StatusLogMessage[]> = {
  news: [
    { timestamp: "06:22:15 AM", level: "INFO", source: "news", message: "NewsAgent successfully aggregated 12 RSS feeds and 3 Reddit subreddits." },
    { timestamp: "06:18:42 AM", level: "WARNING", source: "news", message: "Slight parser delay detected on Twitter API gateway. Latency spiked to 125ms." },
    { timestamp: "06:15:01 AM", level: "INFO", source: "news", message: "Parsed 45 headlines with bullish bias scoring logic (+0.42 structural bias)." },
    { timestamp: "06:05:30 AM", level: "CRITICAL", source: "news", message: "API key rate limits reached on AlphaVantage gateway—switching to alternative sandbox endpoint." }
  ],
  macro: [
    { timestamp: "06:23:02 AM", level: "INFO", source: "macro", message: "MacroAgent completed multi-asset correlation assessment for Q2 treasury yields." },
    { timestamp: "06:20:10 AM", level: "INFO", source: "macro", message: "Injected updated federal discount rate matrices into downstream consensus channels." },
    { timestamp: "06:14:55 AM", level: "WARNING", source: "macro", message: "IMF global productivity reports parsed with mismatched column markers. Cleaned via auto-normalization." },
    { timestamp: "06:01:12 AM", level: "INFO", source: "macro", message: "Successfully refreshed 10Y/2Y yield spread baseline models." }
  ],
  technical: [
    { timestamp: "06:23:40 AM", level: "INFO", source: "technical", message: "Completed 1H EMA crossovers verification on AAPL, AMD, SPY." },
    { timestamp: "06:19:22 AM", level: "WARNING", source: "technical", message: "Database connection pools reached 85% capacity threshold. Pre-emptively purging stale sockets." },
    { timestamp: "06:11:15 AM", level: "INFO", source: "technical", message: "RSI momentum bands calculated. PLTR identified in moderate overbought conditions (74.2)." },
    { timestamp: "05:55:00 AM", level: "INFO", source: "technical", message: "Bollinger Band squeeze triggered on standard indices. Awaiting validation threshold crossover." }
  ],
  sentiment: [
    { timestamp: "06:22:45 AM", level: "INFO", source: "sentiment", message: "Social signal score compiled. Discord and Telegram volume indices up +18%." },
    { timestamp: "06:18:30 AM", level: "WARNING", source: "sentiment", message: "Scraper endpoint warning: Cloudflare challenge detected on retail discussion channels. Automated proxy rotators initialized." },
    { timestamp: "06:10:04 AM", level: "INFO", source: "sentiment", message: "Bullish comment-to-post ratio established at 3.4x over standard historical base." },
    { timestamp: "05:48:19 AM", level: "CRITICAL", source: "sentiment", message: "Parsing engine encountered malformed payload from Stocktwits stream. Resetting parsing buffer." }
  ],
  orderflow: [
    { timestamp: "06:23:45 AM", level: "INFO", source: "orderflow", message: "Level 2 Order Book snapshot matched against institutional wholesale block indicators." },
    { timestamp: "06:22:11 AM", level: "INFO", source: "orderflow", message: "Buy-side imbalances detected for NVDA at $848.50 with 12,400 bid size cluster." },
    { timestamp: "06:17:50 AM", level: "WARNING", source: "orderflow", message: "High volume data feed packet delay: 15ms queue latency observed inside the fast NASDAQ ITCH gateway." },
    { timestamp: "05:59:30 AM", level: "INFO", source: "orderflow", message: "Dark pool trade prints parsed successfully with minimal impact metrics." }
  ],
  proposer: [
    { timestamp: "06:23:46 AM", level: "INFO", source: "proposer", message: "Swarm proposer core collected latest decisions from all 5 sub-agent nodes." },
    { timestamp: "06:18:05 AM", level: "WARNING", source: "proposer", message: "Decision consensus quorum delayed: SentimentAgent vote exceeded timeout boundaries. Using last cached voting state (61% confidence)." },
    { timestamp: "06:12:30 AM", level: "INFO", source: "proposer", message: "Dispatched buyer target suggestions to Risk Manager Node for security verification." },
    { timestamp: "05:50:11 AM", level: "CRITICAL", source: "proposer", message: "Quorum loss: Core Node disconnected momentarily during heartbeats. Re-synchronized within 40ms." }
  ],
  verifier: [
    { timestamp: "06:23:47 AM", level: "INFO", source: "verifier", message: "Risk verification node parsed 2 candidate proposals against active systemic safe boundaries." },
    { timestamp: "06:13:00 AM", level: "WARNING", source: "verifier", message: "Circuit breaker warned: Sector allocation for Technology is near the 65% ceiling. Downstream BUY signals will be heavily penalized." },
    { timestamp: "06:05:12 AM", level: "CRITICAL", source: "verifier", message: "Veto issued: Short trade on AAPL blocked due to extreme high-volatility regime constraint rules." },
    { timestamp: "05:40:02 AM", level: "INFO", source: "verifier", message: "Risk rules and circuit limits synchronized with active memory rules ledger." }
  ],
  executor: [
    { timestamp: "06:23:48 AM", level: "INFO", source: "executor", message: "Execution broker received order fill approvals. Order submitted safely to Alpaca." },
    { timestamp: "06:15:20 AM", level: "INFO", source: "executor", message: "TSLA order execution filled. Got price $342.10 (0.01% slippage)." },
    { timestamp: "06:08:44 AM", level: "WARNING", source: "executor", message: "Execution warning: Slippage exceeds limit on standard trade block. Re-routed to dark liquidity pool." },
    { timestamp: "05:35:10 AM", level: "INFO", source: "executor", message: "Connected to sandbox broker API gateway with validated credentials." }
  ]
};

const globalSystemLogs: StatusLogMessage[] = [
  { timestamp: "06:23:48 AM", level: "INFO", source: "system", message: "Swarm network topology fully synchronized. 8 active nodes operational." },
  { timestamp: "06:21:40 AM", level: "WARNING", source: "system", message: "High latency detected on validator node due to parallel database write lockouts." },
  { timestamp: "06:15:10 AM", level: "INFO", source: "system", message: "Memory rules database committed 3 fresh rules successfully to backend state." }
];

export default function AgentTopologyMap({ flowAnimationEnabled = false }: { flowAnimationEnabled?: boolean }) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("news");
  const [logFilter, setLogFilter] = useState<'ALL' | 'INFO' | 'WARNING' | 'CRITICAL'>('ALL');

  React.useEffect(() => {
    setEdges((eds) => eds.map((e) => ({ ...e, data: { ...e.data, flowAnimationEnabled } })));
  }, [flowAnimationEnabled]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  const onNodeClick = (event: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  };

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const nodeStats = selectedNodeId ? (customDetailedStats[selectedNodeId] || customDetailedStats.news) : null;

  const activeAgentLogs = selectedNodeId ? (agentStatusLogs[selectedNodeId] || globalSystemLogs) : globalSystemLogs;
  const filteredLogs = activeAgentLogs.filter(log => logFilter === 'ALL' || log.level === logFilter);

  return (
    <div className="w-full h-[780px] bg-[#111822] rounded-lg border border-slate-800 relative overflow-hidden flex flex-col md:flex-row shadow-inner" id="interactive-topology-map">
      {/* Topology Canvas Column */}
      <div className="flex-1 relative h-[480px] md:h-full flex flex-col min-w-0">
        
        {/* Canvas on top */}
        <div className="flex-1 min-h-[250px] relative">
          <div className="absolute top-4 left-4 z-10 bg-[#1A1F2B]/90 backdrop-blur-md border border-slate-800 p-3 text-[10px] font-mono text-slate-400 rounded-md shadow-md select-none pointer-events-none">
            <span className="flex items-center gap-1.5 text-white font-bold uppercase mb-1">
              <Activity size={12} className="text-[#3b82f6] animate-pulse"/> 
              Interactive Swarm Canvas
            </span>
            <span className="block text-slate-400">● Drag/pan to align node elements</span>
            <span className="block text-amber-500 font-bold mt-1">★ Click any Node to load Diagnostic telemetry</span>
          </div>
          
          <ReactFlow
            nodes={nodes}
            edges={edges}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            fitView
            className="reactflow-canvas"
          >
            <Background color="#334155" gap={24} size={1} />
            <Controls className="bg-slate-800 border-slate-700 fill-slate-300" />
          </ReactFlow>
        </div>

        {/* Real-time Status Log Panel */}
        <div className="h-[220px] border-t border-slate-800 bg-[#0c1017]/85 p-4 font-mono select-text flex flex-col shrink-0 relative overflow-hidden">
          {/* Panel Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-850 pb-2 mb-2.5 shrink-0 gap-2">
            <div className="flex items-center gap-2">
              <div className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#3b82f6] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#3b82f6]"></span>
              </div>
              <span className="text-[10px] uppercase font-bold text-slate-300 tracking-wider">
                REAL-TIME TELEMETRY LOG : <span className="text-indigo-400 font-extrabold">{nodeStats?.label?.toUpperCase() || "GLOBAL SWARM"}</span>
              </span>
            </div>

            {/* Filter buttons */}
            <div className="flex items-center gap-1 select-none">
              <span className="text-[9px] text-slate-500 mr-1 uppercase font-bold">FILTERS:</span>
              {(['ALL', 'INFO', 'WARNING', 'CRITICAL'] as const).map((filter) => {
                const countOfFilter = activeAgentLogs.filter(log => filter === 'ALL' || log.level === filter).length;
                return (
                  <button
                    key={filter}
                    onClick={() => setLogFilter(filter)}
                    className={`px-2 py-0.5 text-[9px] rounded font-extrabold transition-all border outline-none cursor-pointer ${
                      logFilter === filter
                        ? filter === 'CRITICAL'
                          ? 'bg-rose-500/10 border-rose-500/40 text-rose-400'
                          : filter === 'WARNING'
                            ? 'bg-amber-500/10 border-amber-500/40 text-amber-400'
                            : 'bg-indigo-500/10 border-indigo-500/40 text-indigo-400'
                        : 'bg-[#161d28] border-slate-800 hover:border-slate-700 text-slate-450 hover:text-slate-200'
                    }`}
                  >
                    {filter} ({countOfFilter})
                  </button>
                );
              })}
            </div>
          </div>

          {/* Logs Feed Container */}
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 font-mono text-[10px]">
            {filteredLogs.length > 0 ? (
              filteredLogs.map((log, index) => {
                let badgeStyle = "bg-emerald-500/10 border-emerald-500/20 text-emerald-400";
                if (log.level === "WARNING") {
                  badgeStyle = "bg-amber-500/10 border-amber-500/20 text-amber-400";
                } else if (log.level === "CRITICAL") {
                  badgeStyle = "bg-rose-500/10 border-rose-500/20 text-rose-400";
                }

                return (
                  <div 
                    key={index} 
                    className="flex flex-col sm:flex-row sm:items-start gap-2 p-1.5 rounded bg-slate-900/30 hover:bg-slate-900/60 border border-transparent hover:border-slate-800/40 transition-all leading-normal"
                  >
                    <span className="text-slate-500 shrink-0 select-none">[{log.timestamp}]</span>
                    <span className={`px-1.5 py-0.5 text-[8.5px] font-black rounded border shrink-0 text-center uppercase ${badgeStyle} select-none`}>
                      {log.level}
                    </span>
                    <span className="text-slate-300 font-medium">
                      {log.message}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="h-full flex items-center justify-center text-slate-500 text-[10px] italic">
                No telemetry messages matched the active system search criteria.
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Side Diagnostic Panel Column */}
      <div className="w-full md:w-[410px] h-[340px] md:h-full bg-[#1A1F2B] md:border-l border-t md:border-t-0 border-slate-800 flex flex-col z-20 select-none">
        {nodeStats ? (
          <div className="h-full flex flex-col overflow-y-auto" id="node-detailed-panel">
            {/* Drawer Header */}
            <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/40 shrink-0">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${nodeStats.errorRate > 2 ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500 animate-pulse'}`}></span>
                <h4 className="text-xs font-bold text-white uppercase tracking-wider font-mono truncate max-w-[210px]">
                  {nodeStats.label}
                </h4>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded border border-indigo-500/20 uppercase font-black">
                  {nodeStats.type}
                </span>
                <button 
                  onClick={() => setSelectedNodeId(null)} 
                  className="text-slate-400 hover:text-white transition-colors p-1 rounded hover:bg-slate-800"
                  title="Minimize Panel"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Diagnostic Content Body */}
            <div className="p-4 flex-1 space-y-6">
              
              {/* Core Node Metrics Grid */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-[#111822] border border-slate-800/80 p-2.5 rounded-lg flex flex-col items-center justify-center text-center">
                  <span className="text-[9px] text-slate-550 font-mono uppercase tracking-wider mb-1 flex items-center gap-1">
                    <Wifi size={10} className="text-indigo-400" />
                    Latency
                  </span>
                  <span className="text-xs text-white font-mono font-bold">{nodeStats.ping}</span>
                </div>
                
                <div className="bg-[#111822] border border-slate-800/80 p-2.5 rounded-lg flex flex-col items-center justify-center text-center">
                  <span className="text-[9px] text-slate-550 font-mono uppercase tracking-wider mb-1 flex items-center gap-1">
                    <Cpu size={10} className="text-indigo-400" />
                    Loads
                  </span>
                  <span className="text-xs text-white font-mono font-bold">{nodeStats.throughput} op/m</span>
                </div>

                <div className="bg-[#111822] border border-slate-800/80 p-2.5 rounded-lg flex flex-col items-center justify-center text-center">
                  <span className="text-[9px] text-slate-550 font-mono uppercase tracking-wider mb-1 flex items-center gap-1">
                    <Gauge size={10} className="text-indigo-400" />
                    Win Ratio
                  </span>
                  <span className="text-xs text-emerald-400 font-mono font-bold">
                    {nodeStats.winRate > 0 ? `${nodeStats.winRate}%` : 'N/A'}
                  </span>
                </div>
              </div>

              {/* Real-time Decision Throughput Graph */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-[10px] font-mono font-bold">
                  <span className="text-slate-300 uppercase tracking-widest flex items-center gap-1.5">
                    <Activity size={12} className="text-sky-400" />
                    REAL-TIME DECISION THROUGHPUT
                  </span>
                  <span className="text-sky-400">{nodeStats.throughput} op/m</span>
                </div>
                <div className="h-[100px] w-full bg-[#111822] border border-slate-800/80 rounded p-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={nodeStats.throughputHistory}>
                      <XAxis dataKey="time" stroke="#475569" fontSize={8} tickLine={false} axisLine={false} />
                      <YAxis stroke="#475569" fontSize={8} width={18} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#111822', borderColor: '#334155', fontSize: '9px', fontFamily: 'monospace', color: '#fff' }}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="throughput" 
                        stroke="#0ea5e9" 
                        strokeWidth={2} 
                        dot={{ r: 2, fill: '#0ea5e9' }}
                        activeDot={{ r: 4 }} 
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Historical Error Rate Dashboard */}
              <div className="space-y-3">
                <div className="flex justify-between items-center text-[10px] font-mono font-bold">
                  <span className="text-slate-300 uppercase tracking-widest flex items-center gap-1.5">
                    <AlertTriangle size={12} className="text-rose-400" />
                    HISTORICAL NODE ERROR RATE
                  </span>
                  <div className="text-right">
                    <span className="text-rose-400 font-bold">{nodeStats.errorRate}%</span>
                    <span className="text-[8px] text-slate-500 font-mono block uppercase">{nodeStats.errorCountLabel}</span>
                  </div>
                </div>

                {/* Horizontal Progress bar layers & classification */}
                <div className="bg-[#111822] border border-slate-800/80 rounded p-3 space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col justify-center">
                      <span className="text-[10px] text-slate-500 font-mono uppercase">Node Health</span>
                      <span className={`text-xs font-bold font-mono ${nodeStats.errorRate === 0 ? 'text-emerald-400' : nodeStats.errorRate > 2 ? 'text-amber-500' : 'text-slate-200'}`}>
                        {nodeStats.errorRate === 0 ? 'PRISTINE 100%' : nodeStats.errorRate > 2 ? 'WARNING ' + (100 - nodeStats.errorRate).toFixed(1) + '%' : 'STABLE ' + (100 - nodeStats.errorRate).toFixed(1) + '%'}
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden self-center border border-slate-800 flex">
                      <div 
                        className={`h-full rounded-full ${nodeStats.errorRate > 2 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${100 - (nodeStats.errorRate * 4)}%` }}
                      ></div>
                    </div>
                  </div>

                  {/* Error Categories Bar breakdown */}
                  <div className="space-y-2">
                    <span className="text-[8px] text-slate-555 font-mono uppercase tracking-wider block border-b border-slate-800 pb-1">Error Distribution</span>
                    <div className="space-y-2">
                      {nodeStats.errorBreakdown.map((err, index) => (
                        <div key={index} className="flex flex-col gap-1">
                          <div className="flex justify-between items-center text-[9px] font-mono">
                            <span className="text-slate-400">{err.category}</span>
                            <span className="text-slate-300 font-bold">{err.value} errors</span>
                          </div>
                          <div className="h-1 w-full bg-slate-900 rounded-sm overflow-hidden flex">
                            <div 
                              className={`h-full ${nodeStats.errorRate > 2 ? 'bg-amber-500/80' : 'bg-rose-500/80'}`}
                              style={{ width: `${err.value > 0 ? (err.value / 25) * 100 : 0}%` }}
                            ></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Consensus Voting & Decisions Ledger */}
              <div className="space-y-3">
                <h5 className="text-[10px] font-mono font-bold text-slate-300 uppercase tracking-widest flex items-center gap-1.5">
                  <History size={12} className="text-emerald-400" />
                  CONSENSUS VOTING HISTORY
                </h5>

                <div className="space-y-2">
                  {nodeStats.votingHistory.map((vote, idx) => (
                    <div key={idx} className="bg-[#111822] border border-slate-800/85 p-3 rounded-md space-y-2 hover:border-slate-750 transition-all">
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white uppercase tracking-wider bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">
                            {vote.symbol}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded font-extrabold ${
                            vote.decision === 'BUY' || vote.decision === 'APPROVE' || vote.decision === 'EXECUTE'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : vote.decision === 'SELL' || vote.decision === 'VETO'
                                ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}>
                            {vote.decision}
                          </span>
                        </div>
                        <span className="text-slate-500 text-[9px]">{vote.time}</span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 border-t border-b border-slate-800/60 py-1.5 text-[9px] font-mono">
                        <div>
                          <span className="text-slate-500 uppercase block">Confidence Weight</span>
                          <span className="text-slate-300 font-bold">{vote.weight}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-slate-500 uppercase block">Verdict Outcome</span>
                          <span className={`font-bold ${
                            vote.outcome === 'ACCEPTED' || vote.outcome === 'FILLED' || vote.outcome === 'SENT_TO_EXEC'
                              ? 'text-emerald-400'
                              : vote.outcome === 'VETO_BY_RISK' || vote.outcome === 'BLOCKED'
                                ? 'text-rose-400'
                                : 'text-slate-450'
                          }`}>
                            {vote.outcome}
                          </span>
                        </div>
                      </div>

                      <p className="text-[10px] text-slate-400 font-mono italic select-text leading-relaxed">
                        "{vote.description}"
                      </p>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center text-slate-550 font-mono">
            <Activity className="animate-spin mb-2 text-[#3b82f6]" size={20} />
            <p className="text-[11px] leading-relaxed">System awaiting interaction. Select any swarm agent node within the canvas layout to visualize real-time diagnostics.</p>
          </div>
        )}
      </div>
    </div>
  );
}
