/**
 * ==========================================================
 * Module: RiskAttributionTreemap
 *
 * This used to render a fixed 5-entry array of invented per-agent risk percentages ("Macro
 * Sentiment", "Order Flow", "News Interpreter", "Risk Verifier" - none of which are real Argus
 * agents), with no fetch and no state update ever - the same numbers on every render, forever.
 *
 * Now backed by GET /api/v2/portfolio/risk-attribution: real notional exposure per real symbol
 * currently held in the portfolio, grouped by the same GICS-mapped sector map RiskEngine's own
 * sector-concentration gate uses (PositionSizing.ts's SECTOR_MAP). There is no real per-agent
 * risk-attribution metric anywhere in this codebase - sector/symbol exposure is what real data
 * can actually answer instead.
 * ==========================================================
 */

import React, { useEffect, useState } from 'react';
import { Treemap, Tooltip, ResponsiveContainer } from 'recharts';
import { ShieldAlert } from 'lucide-react';
import AwaitingSignal from './shared/AwaitingSignal';

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
          {payload?.pct}%
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
          Real Exposure: <span className="text-emerald-400">${data?.value?.toLocaleString()}</span> ({data?.pct}% of portfolio)
        </p>
      </div>
    );
  }
  return null;
};

export default function RiskAttributionTreemap() {
  const [data, setData] = useState<any[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/v2/portfolio/risk-attribution')
        .then(r => r.json())
        .then(json => {
          if (cancelled) return;
          if (json.ok) {
            setAvailable(json.available);
            setReason(json.reason || null);
            if (json.available) {
              // Single root (depth 0, invisible) -> sector (depth 1, colored+labeled) -> symbol
              // (depth 2, individually sized within its sector's block) - mirrors the depth
              // semantics CustomizedContent already renders, just with a real extra real level.
              setData([{
                name: 'Portfolio Risk Exposure',
                children: json.data.map((sector: any) => ({
                  name: sector.sector,
                  size: sector.value,
                  value: sector.value,
                  pct: sector.pct,
                  children: sector.symbols.map((s: any) => ({ name: s.symbol, size: s.value, value: s.value, pct: s.pct })),
                })),
              }]);
            }
          } else {
            setAvailable(false);
            setReason(json.error || 'Request failed.');
          }
        })
        .catch(e => { if (!cancelled) { setAvailable(false); setReason(e.message); } });
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 mt-6 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
          <ShieldAlert size={16} className="text-rose-400" />
          Risk Attribution Treemap
        </h3>
        <div className="text-[10px] font-mono tracking-widest uppercase text-slate-500 bg-[#111822] px-2 py-1 rounded border border-slate-700">
          Sector / Symbol Exposure
        </div>
      </div>
      <p className="text-[11px] text-slate-400 mb-6 leading-relaxed max-w-4xl">
        Real current portfolio notional exposure per symbol, grouped by the same real sector map RiskEngine's own sector-concentration gate uses. There is no real per-agent risk attribution in this codebase - this shows what real data can actually answer.
      </p>

      {available === false && (
        <div className="h-[300px] w-full bg-[#111822] rounded border border-slate-800 flex items-center justify-center">
          <AwaitingSignal reason={reason || 'No open real positions in the portfolio.'} label="Risk Attribution" />
        </div>
      )}

      {available === null && (
        <div className="h-[300px] w-full bg-[#111822] rounded border border-slate-800 flex items-center justify-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">
          Loading real portfolio exposure...
        </div>
      )}

      {available === true && data && (
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
      )}
    </div>
  );
}
