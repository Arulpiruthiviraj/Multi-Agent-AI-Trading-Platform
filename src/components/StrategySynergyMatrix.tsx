import React from 'react';
import { Network, Activity } from 'lucide-react';

const agents = [
  "Macro",
  "News",
  "Tech",
  "Sentiment",
  "Event",
  "Geopol"
];

// Mock correlation data between -1.0 and +1.0
// We'll generate a symmetrical matrix with 1.0 on the diagonal
const getCorrelation = (i: number, j: number): number => {
  if (i === j) return 1.0;
  
  // Deterministic mock data based on indices
  const seed = (i * 7 + j * 13) % 100;
  
  // Specific mock rules for flavor
  if ((agents[i] === "Macro" && agents[j] === "Geopol") || (agents[j] === "Macro" && agents[i] === "Geopol")) return 0.85;
  if ((agents[i] === "Tech" && agents[j] === "Sentiment") || (agents[j] === "Tech" && agents[i] === "Sentiment")) return 0.62;
  if ((agents[i] === "Macro" && agents[j] === "Sentiment") || (agents[j] === "Macro" && agents[i] === "Sentiment")) return -0.45;
  
  return (seed / 50) - 1; // Maps to -1.0 to 1.0
};

const getColorForCorrelation = (val: number): string => {
  if (val >= 0.8) return 'bg-emerald-500/90 text-white';
  if (val >= 0.5) return 'bg-emerald-500/50 text-white';
  if (val >= 0.2) return 'bg-emerald-500/20 text-emerald-200';
  if (val > -0.2 && val < 0.2) return 'bg-slate-800 text-slate-400';
  if (val <= -0.8) return 'bg-rose-500/90 text-white';
  if (val <= -0.5) return 'bg-rose-500/50 text-white';
  return 'bg-rose-500/20 text-rose-200';
};

const StrategySynergyMatrix = () => {
  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 lg:p-6 shadow-md relative overflow-hidden group hover:border-indigo-500/30 transition-all duration-300 w-full">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
          <Network size={16} className="text-indigo-400" />
          Strategy Synergy Matrix
        </h3>
        <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest bg-slate-800/50 px-2 py-1 rounded border border-slate-700/50">
          Cross-Agent Correlation
        </div>
      </div>
      
      <p className="text-xs text-slate-400 mb-6 font-mono max-w-2xl">
        Visualizes the correlation coefficient between analytical agents when proposing trades for identical assets. High positive correlation (&gt;0.7) suggests redundant signaling, while negative correlation implies structural hedging.
      </p>

      <div className="overflow-x-auto">
        <div className="min-w-max">
          <div className="flex mb-1">
            <div className="w-24 shrink-0"></div>
            {agents.map((agent, i) => (
              <div key={`header-${i}`} className="w-16 shrink-0 text-center text-[9px] font-mono text-slate-400 uppercase tracking-wider font-bold">
                {agent}
              </div>
            ))}
          </div>
          
          {agents.map((rowAgent, i) => (
            <div key={`row-${i}`} className="flex mb-1 items-center">
              <div className="w-24 shrink-0 text-right pr-4 text-[9px] font-mono text-slate-400 uppercase tracking-wider font-bold">
                {rowAgent}
              </div>
              {agents.map((colAgent, j) => {
                const val = getCorrelation(i, j);
                const colorClass = getColorForCorrelation(val);
                return (
                  <div 
                    key={`cell-${i}-${j}`} 
                    className="w-16 h-8 shrink-0 p-0.5"
                  >
                    <div 
                      className={`w-full h-full rounded flex items-center justify-center text-[10px] font-mono font-medium transition-colors border border-slate-900/50 ${colorClass}`}
                      title={`${rowAgent} vs ${colAgent}: ${val.toFixed(2)}`}
                    >
                      {val.toFixed(2)}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      
      <div className="mt-6 pt-4 border-t border-slate-800/60 flex flex-wrap gap-4 items-center justify-center text-[9px] font-mono uppercase tracking-widest text-slate-500">
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500/90 inline-block"></span> High Sync (+1.0)</div>
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-800 inline-block"></span> Neutral (0.0)</div>
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-rose-500/90 inline-block"></span> Inverse (-1.0)</div>
      </div>
    </div>
  );
};

export default StrategySynergyMatrix;
