import React, { useMemo } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid
} from 'recharts';
import { Zap, Activity } from 'lucide-react';

interface ExecutionQualityChartProps {
  className?: string;
}

const ExecutionQualityChart: React.FC<ExecutionQualityChartProps> = ({ className = "" }) => {
  // Generate dummy data: Execution Speed (ms) vs Slippage (bps) over last 30 days
  const data = useMemo(() => {
    const arr = [];
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      // higher speed = usually higher slippage or variance
      // let's create clusters: optimal, fast but high slippage, slow but precise
      const type = Math.random();
      let speedMs, slippageBps;
      
      if (type > 0.7) {
        // HFT / Fast
        speedMs = 15 + Math.random() * 20; // 15-35ms
        slippageBps = 0.5 + Math.random() * 1.5; // 0.5-2.0 bps
      } else if (type > 0.3) {
        // Standard
        speedMs = 40 + Math.random() * 60; // 40-100ms
        slippageBps = -0.5 + Math.random() * 1.5; // -0.5 to 1.0 bps
      } else {
        // Slow
        speedMs = 150 + Math.random() * 200; // 150-350ms
        slippageBps = -1.0 + Math.random() * 0.5; // price improvement sometimes
      }
      
      arr.push({
        id: `trd-${i}`,
        speedMs,
        slippageBps,
        size: 50 + Math.random() * 200, // volume representation
        timestamp: now - Math.random() * 30 * 24 * 60 * 60 * 1000
      });
    }
    return arr;
  }, []);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-[#111822] border border-slate-700 p-3 rounded shadow-xl text-xs font-mono">
          <p className="text-white font-bold mb-2 uppercase tracking-widest border-b border-slate-800 pb-1">Trade Exec</p>
          <p className="text-emerald-400 mb-1"><span className="text-slate-500 mr-2">Speed:</span> {data.speedMs.toFixed(1)} ms</p>
          <p className="text-amber-400 mb-1"><span className="text-slate-500 mr-2">Slippage:</span> {data.slippageBps.toFixed(2)} bps</p>
          <p className="text-slate-300"><span className="text-slate-500 mr-2">Volume:</span> {data.size.toFixed(0)} shares</p>
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
            Execution Quality: Speed vs Slippage
          </h3>
          <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-widest">Last 30 Days Trade Distribution</p>
        </div>
        <div className="text-[10px] font-mono tracking-widest uppercase text-slate-500 border border-slate-700 bg-[#111822] px-2 py-1 rounded flex gap-4">
          <span className="flex items-center gap-1.5"><Activity size={10} className="text-emerald-400" /> Optimal Zone</span>
          <span className="flex items-center gap-1.5"><Activity size={10} className="text-rose-400" /> High Slippage</span>
        </div>
      </div>
      
      <div className="flex-1 w-full h-[300px] min-h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
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
              dataKey="slippageBps" 
              name="Slippage (bps)" 
              stroke="#475569" 
              tick={{ fill: '#475569', fontSize: 10, fontFamily: 'monospace' }}
              tickFormatter={(val) => `${val}bps`}
              label={{ value: 'Slippage (bps)', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 10, fontFamily: 'monospace' }}
            />
            <ZAxis type="number" dataKey="size" range={[20, 200]} name="Volume" />
            <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3', stroke: '#334155' }} />
            <Scatter 
              name="Trades" 
              data={data} 
              fill="#818cf8"
              fillOpacity={0.6}
              shape="circle"
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default ExecutionQualityChart;
