/**
 * ==========================================================
 * Module:
 * AgentComparisonModal.tsx
 *
 * Purpose:
 * Core implementation and logic for the AgentComparisonModal.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AgentComparisonModalx
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

import React, { useState, useMemo } from 'react';
import { X, Activity, Maximize2, Network } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';

interface AgentComparisonModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentMetrics: Record<string, { sharpe: number, drawdown: number, wins: number }>;
  agentRoiData: any[];
}

export default function AgentComparisonModal({
  isOpen,
  onClose,
  agentMetrics,
  agentRoiData
}: AgentComparisonModalProps) {
  const [agentAlpha, setAgentAlpha] = useState('NewsAgent');
  const [agentBeta, setAgentBeta] = useState('TechnicalAgent');

  const normalizedData = useMemo(() => {
    if (!agentRoiData.length) return [];
    
    // Find initial values for normalization (start at 0)
    const initialAlpha = agentRoiData[0][agentAlpha] || 0;
    const initialBeta = agentRoiData[0][agentBeta] || 0;
    
    return agentRoiData.map(point => ({
      date: point.date,
      [agentAlpha]: point[agentAlpha] - initialAlpha,
      [agentBeta]: point[agentBeta] - initialBeta,
      _originalAlpha: point[agentAlpha],
      _originalBeta: point[agentBeta]
    }));
  }, [agentRoiData, agentAlpha, agentBeta]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg w-full max-w-5xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-[#111822]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-indigo-500/20 flex items-center justify-center text-indigo-400 border border-indigo-500/30">
              <Activity size={16} />
            </div>
            <div>
              <h2 className="text-white font-bold text-sm uppercase tracking-wide">Agent Comparison Matrix</h2>
              <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Normalized Performance Overlay</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors p-2 hover:bg-slate-800 rounded"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
          {/* Controls */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-[#111822] rounded-lg border border-slate-800 p-4">
              <label className="text-[10px] uppercase font-mono tracking-widest text-[#3b82f6] block mb-2">Select Agent Alpha</label>
              <select
                className="w-full bg-[#1A1F2B] border border-slate-700 text-xs text-white rounded p-2.5 focus:outline-none focus:border-blue-500 font-mono"
                value={agentAlpha}
                onChange={(e) => setAgentAlpha(e.target.value)}
              >
                {Object.keys(agentMetrics).map(agent => (
                  <option key={`alpha-${agent}`} value={agent}>{agent}</option>
                ))}
              </select>
            </div>
            
            <div className="bg-[#111822] rounded-lg border border-slate-800 p-4">
              <label className="text-[10px] uppercase font-mono tracking-widest text-[#10b981] block mb-2">Select Agent Beta</label>
              <select
                className="w-full bg-[#1A1F2B] border border-slate-700 text-xs text-white rounded p-2.5 focus:outline-none focus:border-emerald-500 font-mono"
                value={agentBeta}
                onChange={(e) => setAgentBeta(e.target.value)}
              >
                {Object.keys(agentMetrics).map(agent => (
                  <option key={`beta-${agent}`} value={agent}>{agent}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Metrics Table */}
            <div className="lg:col-span-1 flex flex-col">
              <div className="bg-[#111822] rounded-lg border border-slate-800 overflow-hidden flex-1">
                <div className="p-3 border-b border-slate-800 bg-slate-800/20">
                  <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">Key Metrics (90D)</h3>
                </div>
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-800/50 text-[10px] font-mono text-slate-400 uppercase tracking-widest">
                    <tr>
                      <th className="px-4 py-3 border-b border-slate-800">Metric</th>
                      <th className="px-4 py-3 text-[#3b82f6] border-b border-slate-800">Alpha</th>
                      <th className="px-4 py-3 text-[#10b981] border-b border-slate-800">Beta</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    <tr className="hover:bg-slate-800/20 transition-colors">
                      <td className="px-4 py-3 text-slate-300">Sharpe Ratio</td>
                      <td className="px-4 py-3 text-white font-mono">{agentMetrics[agentAlpha]?.sharpe}</td>
                      <td className="px-4 py-3 text-white font-mono">{agentMetrics[agentBeta]?.sharpe}</td>
                    </tr>
                    <tr className="hover:bg-slate-800/20 transition-colors">
                      <td className="px-4 py-3 text-slate-300">Max Drawdown</td>
                      <td className="px-4 py-3 text-rose-400 font-mono">{agentMetrics[agentAlpha]?.drawdown}%</td>
                      <td className="px-4 py-3 text-rose-400 font-mono">{agentMetrics[agentBeta]?.drawdown}%</td>
                    </tr>
                    <tr className="hover:bg-slate-800/20 transition-colors">
                      <td className="px-4 py-3 text-slate-300">Total Wins</td>
                      <td className="px-4 py-3 text-emerald-400 font-mono">{agentMetrics[agentAlpha]?.wins}</td>
                      <td className="px-4 py-3 text-emerald-400 font-mono">{agentMetrics[agentBeta]?.wins}</td>
                    </tr>
                    <tr className="hover:bg-slate-800/20 transition-colors">
                      <td className="px-4 py-3 text-slate-300">Win Rate</td>
                      <td className="px-4 py-3 text-slate-200 font-mono">{((agentMetrics[agentAlpha]?.wins / 300) * 100).toFixed(1)}%</td>
                      <td className="px-4 py-3 text-slate-200 font-mono">{((agentMetrics[agentBeta]?.wins / 300) * 100).toFixed(1)}%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Normalized Chart Overlay */}
            <div className="lg:col-span-3 bg-[#111822] rounded-lg border border-slate-800 flex flex-col">
              <div className="p-3 border-b border-slate-800 bg-slate-800/20 flex justify-between items-center">
                <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                  <Network size={14} className="text-indigo-400" />
                  Normalized Yield Trajectory
                </h3>
                <span className="text-[10px] text-slate-500 font-mono uppercase">Indexed to 0.00%</span>
              </div>
              <div className="flex-1 p-4 min-h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={normalizedData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis dataKey="date" stroke="#475569" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#475569" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(val) => `${val > 0 ? '+' : ''}${val.toFixed(1)}%`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1A1F2B', borderColor: '#1e293b', fontSize: '10px', color: '#f8fafc' }}
                      itemStyle={{ fontSize: '10px' }}
                      labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
                      formatter={(value: number, name: string, props: any) => [
                        `${value > 0 ? '+' : ''}${value.toFixed(2)}% (Real: ${props.payload[`_original${name.includes('Alpha') ? 'Alpha' : 'Beta'}`].toFixed(2)}%)`, 
                        name
                      ]}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
                    <Line type="monotone" dataKey={agentAlpha} stroke="#3b82f6" strokeWidth={2} dot={false} activeDot={{ r: 4 }} name={`${agentAlpha} (Alpha)`} />
                    <Line type="monotone" dataKey={agentBeta} stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 4 }} name={`${agentBeta} (Beta)`} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
