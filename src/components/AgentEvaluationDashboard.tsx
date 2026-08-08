/**
 * ==========================================================
 * Module:
 * AgentEvaluationDashboard.tsx
 *
 * Purpose:
 * Core implementation and logic for the AgentEvaluationDashboard.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AgentEvaluationDashboardx
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

import React, { useState, useEffect } from 'react';
import { Target, TrendingUp, TrendingDown, Activity, Award, Scale, RefreshCw } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';

interface AgentPerformance {
  agentName: string;
  totalPredictions: number;
  correctPredictions: number;
  winRate: number;
  averageReturn: number;
  profitFactor: number;
  sharpeRatio: number;
  currentWeight: number;
  lastEvaluated: string;
}

export default function AgentEvaluationDashboard() {
  const [stats, setStats] = useState<AgentPerformance[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v2/agents/performance");
      const data = await res.json();
      if (data.ok) {
        setStats(data.stats);
      }
    } catch (e) {
      console.error("Failed to fetch agent performance:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-[#05080C] border border-slate-800 rounded-lg p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-bold tracking-widest text-white uppercase flex items-center gap-2">
            <Scale size={20} className="text-emerald-500" /> AI Agent Evaluation & Weighting
          </h2>
          <p className="text-slate-400 text-sm mt-1">Continuous performance loop dynamically sizing agent consensus weight.</p>
        </div>
        <button 
          onClick={fetchStats}
          className="bg-slate-800 hover:bg-slate-700 text-white p-2 rounded transition-colors"
          title="Refresh Stats"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin text-emerald-400' : ''} />
        </button>
      </div>

      {stats.length === 0 && !loading ? (
        <div className="text-center p-12 bg-[#0A0F16] rounded border border-slate-800 border-dashed">
          <Activity size={32} className="mx-auto text-slate-600 mb-3" />
          <p className="text-slate-400 font-mono text-sm uppercase">Awaiting Prediction Data to Evaluate...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          <div className="lg:col-span-2 bg-[#0A0F16] border border-slate-800 rounded p-4">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Relative Consensus Weight Distribution</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                  <XAxis type="number" hide />
                  <YAxis dataKey="agentName" type="category" tick={{fill: '#94a3b8', fontSize: 10}} width={120} />
                  <Tooltip 
                    cursor={{fill: '#1e293b', opacity: 0.4}} 
                    contentStyle={{ backgroundColor: '#0A0F16', borderColor: '#334155', color: '#fff', fontSize: '12px' }} 
                    formatter={(value: any) => [`${(value * 100).toFixed(1)}%`, 'Weight']}
                  />
                  <Bar dataKey="currentWeight" fill="#10b981" radius={[0, 4, 4, 0]} barSize={20} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Agent Leaderboard</h3>
            <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar">
              {[...stats].sort((a,b) => b.winRate - a.winRate).map((agent, i) => (
                <div key={agent.agentName} className="bg-[#111822] border border-slate-800 p-3 rounded flex flex-col relative overflow-hidden">
                  {i === 0 && <div className="absolute top-0 right-0 p-1 bg-amber-500/20 text-amber-500 rounded-bl"><Award size={12}/></div>}
                  <span className="text-xs font-bold text-slate-300 truncate pr-6">{agent.agentName}</span>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <div>
                       <div className="text-[9px] text-slate-500 uppercase">Win Rate</div>
                       <div className={`text-sm font-mono ${agent.winRate > 0.5 ? 'text-emerald-400' : 'text-rose-400'}`}>
                         {(agent.winRate * 100).toFixed(1)}%
                       </div>
                    </div>
                    <div>
                       <div className="text-[9px] text-slate-500 uppercase">Profit Factor</div>
                       <div className="text-sm font-mono text-indigo-400">
                         {agent.profitFactor.toFixed(2)}
                       </div>
                    </div>
                    <div>
                       <div className="text-[9px] text-slate-500 uppercase">Sharpe</div>
                       <div className="text-sm font-mono text-slate-300">
                         {agent.sharpeRatio.toFixed(2)}
                       </div>
                    </div>
                    <div>
                       <div className="text-[9px] text-slate-500 uppercase">Predictions</div>
                       <div className="text-sm font-mono text-slate-300">
                         {agent.totalPredictions}
                       </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
