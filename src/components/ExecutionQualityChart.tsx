/**
 * ==========================================================
 * Module: ExecutionQualityChart
 *
 * Phase 1A (Remediation Verification Pass, FINAL_ANALYSIS.md Section 25.3's follow-up) - this
 * used to synthesize 60 fake trades per render via `Date.now() % 1000` jitter, including a fake
 * "slippage" figure. Now backed by GET /api/v2/trading/execution-quality: real submit-to-fill
 * latency for real FILLED trades. Slippage is deliberately NOT plotted - neither `trades` nor
 * `risk_assessments` persists the price RiskEngine evaluated the proposal against, so there is no
 * real slippage value to show (see the endpoint's own comment). Real order size is plotted
 * instead, which real data can actually answer ("does size correlate with fill speed?").
 * ==========================================================
 */

import React, { useEffect, useState } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  CartesianGrid
} from 'recharts';
import { Zap, Activity, AlertTriangle } from 'lucide-react';
import { SafeResponsiveContainer } from './shared/SafeResponsiveContainer';

interface ExecutionQualityChartProps {
  className?: string;
}

interface ExecutionPoint {
  id: string;
  symbol: string;
  side: string;
  speedMs: number;
  quantity: number;
  timestamp: string;
}

const ExecutionQualityChart: React.FC<ExecutionQualityChartProps> = ({ className = "" }) => {
  const [data, setData] = useState<ExecutionPoint[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v2/trading/execution-quality')
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        if (json.ok) {
          setAvailable(json.available);
          setData(json.data || []);
          setReason(json.reason || null);
        } else {
          setAvailable(false);
          setReason(json.error || 'Request failed.');
        }
      })
      .catch(e => {
        if (cancelled) return;
        setAvailable(false);
        setReason(e.message);
      });
    return () => { cancelled = true; };
  }, []);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const d: ExecutionPoint = payload[0].payload;
      return (
        <div className="bg-[#111822] border border-slate-700 p-3 rounded shadow-xl text-xs font-mono">
          <p className="text-white font-bold mb-2 uppercase tracking-widest border-b border-slate-800 pb-1">{d.symbol} {d.side}</p>
          <p className="text-emerald-400 mb-1"><span className="text-slate-500 mr-2">Speed:</span> {d.speedMs.toFixed(0)} ms</p>
          <p className="text-slate-300"><span className="text-slate-500 mr-2">Quantity:</span> {d.quantity} shares</p>
          <p className="text-slate-500 text-[10px] mt-1">{new Date(d.timestamp).toLocaleString()}</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className={`bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col ${className}`}>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
            <Zap size={16} className="text-indigo-400" />
            Execution Quality: Speed vs Order Size
          </h3>
          <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-widest">Last 30 Days, Real Filled Orders</p>
        </div>
      </div>

      {available === false && (
        <div className="flex-1 flex flex-col items-center justify-center py-12 text-center gap-2 min-h-[300px]">
          <AlertTriangle size={22} className="text-amber-500/70" />
          <p className="text-xs font-mono uppercase tracking-widest text-amber-400/90">Execution Data Unavailable</p>
          <p className="text-[10px] text-slate-500 max-w-sm">{reason || 'No FILLED trades with timing data in the last 30 days.'}</p>
        </div>
      )}

      {available === null && (
        <div className="flex-1 flex items-center justify-center py-12 text-[10px] font-mono text-slate-500 uppercase tracking-widest min-h-[300px]">
          Loading real execution data...
        </div>
      )}

      {available === true && data && (
        <div className="flex-1 w-full h-[300px] min-h-[300px]">
          <SafeResponsiveContainer>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis
                type="number"
                dataKey="speedMs"
                name="Speed (ms)"
                stroke="#475569"
                tick={{ fill: '#475569', fontSize: 10, fontFamily: 'monospace' }}
                tickFormatter={(val) => `${val}ms`}
                label={{ value: 'Execution Speed (ms)', position: 'insideBottom', offset: -10, fill: '#64748b', fontSize: 10, fontFamily: 'monospace' }}
              />
              <YAxis
                type="number"
                dataKey="quantity"
                name="Quantity"
                stroke="#475569"
                tick={{ fill: '#475569', fontSize: 10, fontFamily: 'monospace' }}
                label={{ value: 'Order Size (shares)', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 10, fontFamily: 'monospace' }}
              />
              <ZAxis type="number" dataKey="quantity" range={[20, 200]} name="Size" />
              <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3', stroke: '#334155' }} />
              <Scatter
                name="Trades"
                data={data}
                fill="#818cf8"
                fillOpacity={0.6}
                shape="circle"
              />
            </ScatterChart>
          </SafeResponsiveContainer>
        </div>
      )}
    </div>
  );
};

export default ExecutionQualityChart;
