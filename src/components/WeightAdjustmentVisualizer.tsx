import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';

interface WeightData {
  name: string;
  before: number;
  after: number;
}

interface WeightAdjustmentVisualizerProps {
  rule: string;
  seed: number;
}

export default function WeightAdjustmentVisualizer({ rule, seed }: WeightAdjustmentVisualizerProps) {
  const [showAfter, setShowAfter] = useState(false);

  // Generate slightly deterministic mock data based on seed
  const generateMockNodes = () => {
    const nodes = ["Momentum Breakout", "Mean Reversion", "News Sentiment", "Trend Following (200d)", "Volatility Scalp"];
    
    // Pick 3 random nodes using the seed
    const n1 = nodes[seed % nodes.length];
    const n2 = nodes[(seed + 1) % nodes.length];
    const n3 = nodes[(seed + 2) % nodes.length];

    return [
      { name: n1, before: 45 + (seed % 10), after: 25 - (seed % 5) },
      { name: n2, before: 30 - (seed % 10), after: 45 + (seed % 10) },
      { name: n3, before: 25, after: 30 }
    ];
  };

  const weights: WeightData[] = generateMockNodes();

  return (
    <div className="mt-4 border-t border-slate-800/50 pt-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
        <span className="text-[10px] uppercase font-mono text-slate-500">Agent Weighting Snapshot</span>
        <div className="flex items-center bg-[#0A0F16] p-1 rounded border border-slate-800">
          <button 
            onClick={() => setShowAfter(false)}
            className={`text-[9px] px-4 py-1.5 font-mono uppercase tracking-widest rounded transition-all ${!showAfter ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
          >
            Before
          </button>
          <div className="px-2 text-slate-700">
             <ArrowRight size={12} />
          </div>
          <button 
            onClick={() => setShowAfter(true)}
            className={`text-[9px] px-4 py-1.5 font-mono uppercase tracking-widest rounded transition-all ${showAfter ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
          >
            After Adjustment
          </button>
        </div>
      </div>

      <div className="space-y-3 p-3 bg-[#0A0F16]/50 rounded-lg border border-slate-800/50">
        {weights.map((w, i) => {
          const currentVal = showAfter ? w.after : w.before;
          const isUp = showAfter && w.after > w.before;
          const isDown = showAfter && w.after < w.before;
          
          let barColor = 'bg-indigo-500';
          if (showAfter) {
            if (isUp) barColor = 'bg-emerald-500';
            if (isDown) barColor = 'bg-rose-500';
          }

          return (
            <div key={i} className="flex items-center gap-3">
              <span className={`text-[10px] font-mono w-32 truncate transition-colors ${showAfter ? 'text-white' : 'text-slate-400'}`}>
                {w.name}
              </span>
              <div className="flex-1 bg-slate-800/50 h-2 rounded-full overflow-hidden relative">
                <div 
                  className={`h-full transition-all duration-700 ease-out ${barColor}`} 
                  style={{ width: `${currentVal}%` }}
                ></div>
                {/* Show faint outline of before state when in 'after' view */}
                {showAfter && (
                   <div 
                      className="absolute top-0 bottom-0 border-r-2 border-slate-500/30 z-10 transition-all duration-700"
                      style={{ width: `${w.before}%` }}
                   ></div>
                )}
              </div>
              <span className={`text-[10px] font-mono font-bold w-12 text-right transition-colors ${isUp ? 'text-emerald-400' : isDown ? 'text-rose-400' : 'text-white'}`}>
                {currentVal}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
