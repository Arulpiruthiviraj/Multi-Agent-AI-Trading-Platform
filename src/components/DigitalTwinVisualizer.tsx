import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactFlow, { 
  MiniMap, Controls, Background, useNodesState, useEdgesState, addEdge, 
  MarkerType, Handle, Position, Edge, Node 
} from 'reactflow';
import 'reactflow/dist/style.css';
import { 
  Activity, Database, Search, Newspaper, Clock, BookOpen, RefreshCw, Terminal, 
  BrainCircuit, TrendingUp, Layers, ShieldCheck, UserCheck, Send, Info, X, Pause, Play
} from 'lucide-react';
import NodeInspectionPanel from './NodeInspectionPanel';

const CustomNode = ({ data, isConnectable }: any) => {
  return (
    <div className={`px-4 py-3 w-48 shadow-lg rounded-xl bg-[#0A0F16] border-2 transition-all duration-300 ${data.status === 'RUNNING' || data.status === 'ACTIVE' ? 'border-indigo-500 shadow-[0_0_20px_rgba(99,102,241,0.4)] scale-105' : 'border-slate-800'}`}>
      <Handle type="target" position={Position.Top} isConnectable={isConnectable} className="w-2 h-2 bg-slate-500 border-none" />
      <div className="flex items-center gap-3">
        <div className={`rounded-lg p-2.5 transition-colors ${data.status === 'RUNNING' || data.status === 'ACTIVE' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-slate-800 text-slate-500'}`}>
          {data.icon}
        </div>
        <div>
          <div className="text-[10px] font-bold text-white uppercase tracking-widest leading-tight">{data.label}</div>
          <div className="text-[8px] text-slate-400 mt-0.5">{data.description}</div>
          <div className="text-[8px] text-indigo-300 mt-1 flex gap-2">
            <span>CPU: {data.cpu}%</span>
            <span>MEM: {data.memory}M</span>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={isConnectable} className="w-2 h-2 bg-slate-500 border-none" />
    </div>
  );
};

const nodeTypes = { custom: CustomNode };

export default function DigitalTwinVisualizer() {
  const [events, setEvents] = useState<any[]>([]);
  const [activeNodes, setActiveNodes] = useState<Set<string>>(new Set());
  const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<any>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [systemMetrics, setSystemMetrics] = useState<any>(null);

  // Define static nodes for the pipeline
    const initialNodes: Node[] = [
    { id: 'market-data-worker', type: 'custom', position: { x: 50, y: 50 }, data: { label: 'Market Data', icon: <Activity size={18}/>, description: 'Live Price & Volume', status: 'IDLE' } },
    { id: 'news-agent', type: 'custom', position: { x: 300, y: 50 }, data: { label: 'News Intelligence', icon: <Newspaper size={18}/>, description: 'Sentiment Processing', status: 'IDLE' } },
    { id: 'fundamental-agent', type: 'custom', position: { x: 450, y: 50 }, data: { label: 'Fundamental Agent', icon: <Activity size={18}/>, description: 'Value & EPS', status: 'IDLE' } },
    { id: 'macro-agent', type: 'custom', position: { x: 600, y: 50 }, data: { label: 'Macro Agent', icon: <Activity size={18}/>, description: 'Fed & Inflation', status: 'IDLE' } },
    { id: 'portfolio-monitor', type: 'custom', position: { x: 750, y: 50 }, data: { label: 'Portfolio Manager', icon: <Clock size={18}/>, description: 'Position Checks', status: 'IDLE' } },
    
    { id: 'technical-engine', type: 'custom', position: { x: 50, y: 200 }, data: { label: 'Technical Engine', icon: <TrendingUp size={18}/>, description: 'RSI, MACD, Breakouts', status: 'IDLE' } },
    { id: 'quant-engine', type: 'custom', position: { x: 50, y: 350 }, data: { label: 'Advanced Quant', icon: <Activity size={18}/>, description: 'Multi-TF, Volatility', status: 'IDLE' } },
    
    { id: 'chief-trader', type: 'custom', position: { x: 400, y: 350 }, data: { label: 'Chief Trader (AI)', icon: <UserCheck size={18}/>, description: 'Consensus & Routing', status: 'IDLE' } },
    { id: 'risk-manager', type: 'custom', position: { x: 400, y: 500 }, data: { label: 'Risk Validation', icon: <ShieldCheck size={18}/>, description: 'Sizing & Veto Constraints', status: 'IDLE' } },
    { id: 'order-management', type: 'custom', position: { x: 400, y: 650 }, data: { label: 'Execution Service', icon: <Send size={18}/>, description: 'Broker Routing', status: 'IDLE' } },
    { id: 'learning-engine', type: 'custom', position: { x: 750, y: 650 }, data: { label: 'Reflection Engine', icon: <BookOpen size={18}/>, description: 'Post-trade Learning', status: 'IDLE' } },
  ];

    const initialEdges: Edge[] = [
    { id: 'e-market-tech', source: 'market-data-worker', target: 'technical-engine', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-market-quant', source: 'market-data-worker', target: 'quant-engine', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    
    { id: 'e-tech-chief', source: 'technical-engine', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-quant-chief', source: 'quant-engine', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-news-chief', source: 'news-agent', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-fund-chief', source: 'fundamental-agent', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-macro-chief', source: 'macro-agent', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-port-chief', source: 'portfolio-monitor', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    
    { id: 'e-chief-risk', source: 'chief-trader', target: 'risk-manager', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-risk-exec', source: 'risk-manager', target: 'order-management', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-exec-learn', source: 'order-management', target: 'learning-engine', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
  ];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    let isMounted = true;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onmessage = (event) => {
      if (!isPlaying) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'SYSTEM_METRICS') {
           setSystemMetrics(msg.data);
           return;
        }
        
        const newEvent = {
           id: Math.random().toString(36).substring(7),
           type: msg.type,
           timestamp: new Date().toISOString(),
           payload: msg.data
        };
        setEvents(prev => {
          const updated = [newEvent, ...prev].slice(0, 50);
          updateGraphFromEvents(updated);
          return updated;
        });
      } catch(e) {}
    };

    return () => {
      isMounted = false;
      ws.close();
    };
  }, [isPlaying]);


    const updateGraphFromEvents = (latestEvents: any[]) => {
    // Only look at events from the last 3 seconds for animation
    const now = Date.now();
    const recent = latestEvents.filter(e => (now - new Date(e.timestamp).getTime()) < 3500);
    
    const newActiveNodes = new Set<string>();
    const newActiveEdges = new Set<string>();

    recent.forEach((evt) => {
      if (evt.type === 'MARKET_DATA') {
        newActiveNodes.add('market-data-worker');
        newActiveEdges.add('e-market-tech');
        newActiveEdges.add('e-market-quant');
      } else if (evt.type === 'QUANT_ENGINE_OUTPUT') {
        newActiveNodes.add('quant-engine');
        newActiveEdges.add('e-quant-chief');
      } else if (evt.type === 'TRADE_IDEA_GENERATED') {
        if (evt.payload.agent === 'TechnicalAgent') {
           newActiveNodes.add('technical-engine');
           newActiveEdges.add('e-tech-chief');
        }
        if (evt.payload.agent === 'NewsAgent') {
           newActiveNodes.add('news-agent');
           newActiveEdges.add('e-news-chief');
        }
        if (evt.payload.agent === 'FundamentalAgent') {
           newActiveNodes.add('fundamental-agent');
           newActiveEdges.add('e-fund-chief');
        }
        if (evt.payload.agent === 'MacroAgent') {
           newActiveNodes.add('macro-agent');
           newActiveEdges.add('e-macro-chief');
        }
        if (evt.payload.agent === 'PortfolioManager') {
           newActiveNodes.add('portfolio-monitor');
           newActiveEdges.add('e-port-chief');
        }
        newActiveNodes.add('chief-trader');
      } else if (evt.type === 'CHIEF_APPROVED_IDEA') {
        newActiveNodes.add('chief-trader');
        newActiveEdges.add('e-chief-risk');
        newActiveNodes.add('risk-manager');
      } else if (evt.type === 'RISK_ASSESSMENT_COMPLETED') {
        newActiveNodes.add('risk-manager');
        if (evt.payload.approved) {
           newActiveEdges.add('e-risk-exec');
           newActiveNodes.add('order-management');
        }
      } else if (evt.type === 'ORDER_EXECUTED') {
        newActiveNodes.add('order-management');
        newActiveEdges.add('e-exec-learn');
        newActiveNodes.add('learning-engine');
      } else if (evt.type === 'LEARNED_NEW_RULE') {
        newActiveNodes.add('learning-engine');
      }
    });

    setActiveNodes(newActiveNodes);
    setActiveEdges(newActiveEdges);
  };

  useEffect(() => {
    setNodes((nds) => 
      nds.map((node) => ({
        ...node,
        data: {
          ...node.data,
          status: activeNodes.has(node.id) ? 'ACTIVE' : 'IDLE', cpu: (systemMetrics?.processes?.[node.id]?.cpu || "0.0"), memory: (systemMetrics?.processes?.[node.id]?.memory || "0")
        }
      }))
    );

    setEdges((eds) => 
      eds.map((edge) => ({
        ...edge,
        animated: activeEdges.has(edge.id),
        style: activeEdges.has(edge.id) 
          ? { stroke: '#818cf8', strokeWidth: 3, opacity: 1 } 
          : { stroke: '#334155', strokeWidth: 2, opacity: 0.5 }
      }))
    );
  }, [activeNodes, activeEdges, setNodes, setEdges]);

  return (
    <div className="flex flex-col h-[800px] gap-4">
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Layers size={20} className="text-indigo-400" />
            Autonomous Trading Digital Twin
          </h2>
          <p className="text-xs text-slate-400 mt-1 font-mono">Live visualization of autonomous multi-agent trading pipelines.</p>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => setIsPlaying(!isPlaying)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-[10px] font-bold tracking-widest uppercase transition-colors ${isPlaying ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}
          >
            {isPlaying ? <Pause size={14}/> : <Play size={14}/>}
            {isPlaying ? 'LIVE STREAMING' : 'PAUSED'}
          </button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 flex-1 h-full">
        {/* ReactFlow Canvas */}
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
             <NodeInspectionPanel 
                 nodeId={selectedNodeId} 
                 onClose={() => setSelectedNodeId(null)} 
                 activeEvents={events} 
             />
          )}
        </div>

        {/* Live Event Stream Panel */}
        <div className="w-full lg:w-96 bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex flex-col h-[600px] lg:h-full overflow-hidden">
          <h3 className="text-[11px] font-mono font-bold uppercase tracking-widest text-slate-400 flex justify-between items-center mb-4 border-b border-slate-800 pb-2">
            <span>Live Trace Logs</span>
            {isPlaying && <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.8)]"></span>}
          </h3>
          <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar pr-2">
            {events.map((evt, idx) => (
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
                   {evt.type === 'MARKET_DATA' ? `Tick: ${evt.payload.symbol} @ $${evt.payload.price.toFixed(2)} Vol: ${evt.payload.volume}` :
                    evt.type === 'TRADE_IDEA_GENERATED' ? `Agent: ${evt.payload.agent}\nIdea: ${evt.payload.side} ${evt.payload.symbol}\nConf: ${(evt.payload.confidence * 100).toFixed(0)}%` :
                    evt.type === 'CHIEF_APPROVED_IDEA' ? `Chief Approved: ${evt.payload.side} ${evt.payload.symbol}\nContext: ${evt.payload.agentsContext}` :
                    evt.type === 'RISK_ASSESSMENT_COMPLETED' ? `Risk: ${evt.payload.approved ? 'PASS' : 'VETO'}\nSymbol: ${evt.payload.symbol}\nCap: ${evt.payload.maxQuantity} shares` :
                    evt.type === 'ORDER_EXECUTED' ? `Execution: ${evt.payload.side} ${evt.payload.quantity}x ${evt.payload.symbol}\nFill: $${evt.payload.price.toFixed(2)}` :
                    JSON.stringify(evt.payload)
                   }
                </div>
              </div>
            ))}
            {events.length === 0 && (
              <div className="text-center text-slate-600 font-mono text-[10px] mt-10 italic">
                Awaiting events...
              </div>
            )}
          </div>
        </div>
      </div>

      {selectedEvent && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-[#1A1F2B] border border-slate-700 rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
             <div className="flex justify-between items-center p-4 border-b border-slate-800">
                <h3 className="text-indigo-400 font-mono font-bold tracking-wider flex items-center gap-2">
                  <Activity size={16} /> Workflow Inspection: {selectedEvent.type}
                </h3>
                <button onClick={() => setSelectedEvent(null)} className="text-slate-400 hover:text-white bg-slate-800 p-1 rounded">
                  <X size={16} />
                </button>
             </div>
             <div className="p-6 overflow-y-auto">
               <div className="mb-4">
                 <h4 className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-2">Internal Payload Data</h4>
                 <pre className="bg-[#0A0F16] p-4 rounded border border-slate-800 text-[11px] text-emerald-400 font-mono whitespace-pre-wrap">
                   {JSON.stringify(selectedEvent.payload, null, 2)}
                 </pre>
               </div>
               
               <div className="bg-indigo-900/10 border border-indigo-500/20 p-4 rounded text-[11px] text-indigo-300 font-mono">
                 This data packet represents a real-time event flowing through the autonomous architecture. 
                 It is processed sequentially by downstream nodes or agents in the graph.
               </div>
               
               <div className="mt-4 flex justify-between items-center border-t border-slate-800 pt-4">
                  <span className="text-[10px] text-slate-500 font-mono">ID: {selectedEvent.id}</span>
                  <span className="text-[10px] text-slate-500 font-mono">Timestamp: {new Date(selectedEvent.timestamp).toLocaleString()}</span>
               </div>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
