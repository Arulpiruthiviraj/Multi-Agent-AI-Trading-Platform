/**
 * ==========================================================
 * Module:
 * RiskAttributionTreemap.tsx
 *
 * Purpose:
 * Core implementation and logic for the RiskAttributionTreemap.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for RiskAttributionTreemapx
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
import { Treemap, Tooltip, ResponsiveContainer } from 'recharts';
import { ShieldAlert } from 'lucide-react';

const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#06b6d4', '#6366f1'];

interface CustomContentProps {
  root: any;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  payload: any;
  colors: string[];
  rank: number;
  name: string;
}

const CustomizedContent: React.FC<CustomContentProps> = (props) => {
  const { root, depth, x, y, width, height, index, colors, name, payload } = props;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        style={{
          fill: depth < 2 ? colors[Math.floor((index / root.children.length) * 6)] : '#ffffff00',
          stroke: '#1A1F2B',
          strokeWidth: 2 / (depth + 1e-10),
          strokeOpacity: 1 / (depth + 1e-10),
        }}
      />
      {depth === 1 ? (
        <text
          x={x + width / 2}
          y={y + height / 2 + 7}
          textAnchor="middle"
          fill="#fff"
          fontSize={12}
          className="font-mono font-bold tracking-wider pointer-events-none"
        >
          {name}
        </text>
      ) : null}
      {depth === 1 ? (
        <text
          x={x + 4}
          y={y + 14}
          fill="#fff"
          fontSize={10}
          fillOpacity={0.7}
          className="font-mono pointer-events-none"
        >
          {payload?.value}%
        </text>
      ) : null}
    </g>
  );
};

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-[#111822] border border-slate-700 p-3 rounded shadow-lg">
        <p className="text-white font-mono text-xs font-bold mb-1">{data?.name}</p>
        <p className="text-slate-400 font-mono text-[10px]">
          Risk Contribution: <span className="text-emerald-400">{data?.value}%</span>
        </p>
        <p className="text-slate-500 font-mono text-[10px] mt-1 italic">
          {data?.description}
        </p>
      </div>
    );
  }
  return null;
};

export default function RiskAttributionTreemap() {
  const [data, setData] = useState([
    {
      name: 'Agent Risk Allocation',
      children: [
        { name: 'Macro Sentiment', size: 35, value: 35, description: 'High sensitivity to CPI and FOMC announcements' },
        { name: 'Order Flow', size: 25, value: 25, description: 'L2 Book depth imbalances and large block trades' },
        { name: 'Technical Analysis', size: 20, value: 20, description: 'Moving average crossovers and RSI divergence' },
        { name: 'News Interpreter', size: 12, value: 12, description: 'Real-time headline NLP sentiment parsing' },
        { name: 'Risk Verifier', size: 8, value: 8, description: 'Systematic hard-stops and trailing guardrails' },
      ],
    },
  ]);

  

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 mt-6 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
          <ShieldAlert size={16} className="text-rose-400" />
          Risk Attribution Treemap
        </h3>
        <div className="text-[10px] font-mono tracking-widest uppercase text-slate-500 bg-[#111822] px-2 py-1 rounded border border-slate-700">
          Agent Contribution %
        </div>
      </div>
      <p className="text-[11px] text-slate-400 mb-6 leading-relaxed max-w-4xl">
        Real-time breakdown of portfolio risk exposure attributed to each specific agent model. The area of each rectangle represents the proportional influence of that agent's signals on current open positions.
      </p>
      
      <div className="h-[300px] w-full bg-[#111822] rounded overflow-hidden border border-slate-800">
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={data}
            dataKey="size"
            aspectRatio={4 / 3}
            stroke="#1A1F2B"
            fill="#3b82f6"
            content={<CustomizedContent colors={COLORS} root={undefined} depth={0} x={0} y={0} width={0} height={0} index={0} payload={undefined} rank={0} name={''} />}
          >
            <Tooltip content={<CustomTooltip />} />
          </Treemap>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
