/**
 * ==========================================================
 * Module:
 * VectorClusteringMap.tsx
 *
 * Purpose:
 * Core implementation and logic for the VectorClusteringMap.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for VectorClusteringMapx
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

import React, { useMemo } from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ZAxis, Cell } from 'recharts';
import { Layers } from 'lucide-react';

const sampleData = [
  { name: '2008 Financial Crisis', x: -45, y: 60, type: 'systemic', score: 0.95 },
  { name: 'Dot Com Bubble', x: 20, y: 55, type: 'systemic', score: 0.8 },
  { name: 'COVID-19 Crash', x: -60, y: -20, type: 'supply', score: 0.92 },
  { name: '1970s Oil Shock', x: -50, y: -50, type: 'supply', score: 0.85 },
  { name: 'European Debt Crisis', x: 30, y: 40, type: 'sovereign', score: 0.75 },
  { name: 'Brexit', x: 50, y: -10, type: 'sovereign', score: 0.65 },
  { name: '2015 Chinese Stock Crash', x: 10, y: 15, type: 'systemic', score: 0.6 },
  { name: 'Black Monday 1987', x: -10, y: 70, type: 'systemic', score: 0.88 },
  { name: 'Russian Default 1998', x: 40, y: 30, type: 'sovereign', score: 0.7 },
  { name: 'Fukushima Disaster', x: -40, y: -30, type: 'supply', score: 0.6 },
  { name: 'Suez Canal Blockage', x: -20, y: -60, type: 'supply', score: 0.5 },
  { name: 'US Debt Downgrade 2011', x: 60, y: 20, type: 'sovereign', score: 0.78 }
];

const COLORS = {
  systemic: '#ef4444', // rose-500
  supply: '#3b82f6', // blue-500
  sovereign: '#10b981' // emerald-500
};

export default function VectorClusteringMap() {
  
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg shadow-xl font-mono text-xs z-50">
          <p className="text-white font-bold mb-1">{data.name}</p>
          <div className="flex items-center gap-2 mb-1 text-[10px] uppercase tracking-wider">
             <span className="text-slate-500">Regime:</span>
             <span style={{color: COLORS[data.type as keyof typeof COLORS]}}>{data.type}</span>
          </div>
          <p className="text-slate-400 text-[10px]">Similarity Score: {(data.score * 100).toFixed(0)}%</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col h-full">
      <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-1.5 uppercase tracking-wide">
        <Layers size={16} className="text-purple-400" />
        Vector Space Clustering (t-SNE)
      </h3>
      <p className="text-xs text-slate-400 mb-6 leading-relaxed font-mono">
        2D projection of historical event embeddings. Shows how the reflection agent clusters different market regimes to find precedents.
      </p>
      
      <div className="flex-1 w-full min-h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis type="number" dataKey="x" name="Dimension 1" hide domain={[-80, 80]} />
            <YAxis type="number" dataKey="y" name="Dimension 2" hide domain={[-80, 80]} />
            <ZAxis type="number" dataKey="score" range={[60, 200]} name="Relevance" />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<CustomTooltip />} />
            <Scatter name="Historical Events" data={sampleData}>
              {sampleData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[entry.type as keyof typeof COLORS]} opacity={0.7} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      
      <div className="mt-4 flex gap-4 justify-center text-[10px] font-mono uppercase tracking-wider">
         <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-rose-500"></div> <span className="text-slate-400">Systemic Crises</span></div>
         <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-blue-500"></div> <span className="text-slate-400">Supply Shocks</span></div>
         <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-emerald-500"></div> <span className="text-slate-400">Sovereign Shocks</span></div>
      </div>
    </div>
  );
}
