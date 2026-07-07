import React, { useState } from 'react';
import { Info, Layers, Activity, AlertOctagon, HelpCircle, Network, TrendingUp } from 'lucide-react';

const AGENTS = [
  "NewsAgent",
  "MacroAgent",
  "TechAgent",
  "SentAgent",
  "FlowAgent"
];

// Volatility Regimes representing different correlation matrices
const baselineCorrelation = [
  [1.00, 0.20, -0.10, 0.80, -0.20], // NewsAgent
  [0.20, 1.00, 0.40, 0.10, 0.50],  // MacroAgent
  [-0.10, 0.40, 1.00, -0.30, 0.70], // TechAgent
  [0.80, 0.10, -0.30, 1.00, -0.40], // SentAgent
  [-0.20, 0.50, 0.70, -0.40, 1.00], // FlowAgent
];

const macroCorrelation = [
  [1.00, 0.55, 0.20, 0.90, -0.40],  // NewsAgent
  [0.55, 1.00, 0.60, 0.45, 0.80],  // MacroAgent
  [0.20, 0.60, 1.00, 0.10, 0.75],  // TechAgent
  [0.90, 0.45, 0.10, 1.00, -0.35], // SentAgent
  [-0.40, 0.80, 0.75, -0.35, 1.00], // FlowAgent
];

const blackSwanCorrelation = [
  [1.00, 0.85, 0.78, 0.92, 0.81],  // NewsAgent
  [0.85, 1.00, 0.82, 0.89, 0.88],  // MacroAgent
  [0.78, 0.82, 1.00, 0.75, 0.91],  // TechAgent
  [0.92, 0.89, 0.75, 1.00, 0.84],  // SentAgent
  [0.81, 0.88, 0.91, 0.84, 1.00],  // FlowAgent
];

// Co-authorizations (transaction overlap metrics)
const baselineCoAuth = [
  [300, 45, 12, 210, 8],
  [45, 240, 89, 22, 115],
  [12, 89, 450, 15, 180],
  [210, 22, 15, 280, 5],
  [8, 115, 180, 5, 520],
];

const macroCoAuth = [
  [450, 120, 40, 380, 12],
  [120, 500, 210, 60, 315],
  [40, 210, 380, 25, 290],
  [380, 60, 25, 420, 15],
  [12, 315, 290, 15, 600],
];

const blackSwanCoAuth = [
  [980, 840, 720, 910, 680],
  [840, 1120, 890, 810, 950],
  [720, 890, 1250, 690, 1110],
  [910, 810, 690, 1180, 790],
  [680, 950, 1110, 790, 1420],
];

type Regime = 'baseline' | 'macro' | 'blackswan';

export default function TradeCorrelationMatrix() {
  const [hoveredCell, setHoveredCell] = useState<{ row: number, col: number } | null>(null);
  const [isClusteringEnabled, setIsClusteringEnabled] = useState(true);
  const [activeRegime, setActiveRegime] = useState<Regime>('baseline');

  // Determine active datasets based on regime and clustering toggle
  const getActiveData = () => {
    if (!isClusteringEnabled) {
      return { corr: baselineCorrelation, coAuth: baselineCoAuth };
    }
    switch (activeRegime) {
      case 'macro':
        return { corr: macroCorrelation, coAuth: macroCoAuth };
      case 'blackswan':
        return { corr: blackSwanCorrelation, coAuth: blackSwanCoAuth };
      case 'baseline':
      default:
        return { corr: baselineCorrelation, coAuth: baselineCoAuth };
    }
  };

  const { corr: activeCorrelationData, coAuth: activeCoAuthorizations } = getActiveData();

  const getCellColor = (value: number) => {
    if (value === 1) return 'bg-[#1e293b]/70 border-slate-700 text-slate-500 font-bold';
    
    if (value > 0.8) return 'bg-emerald-500 text-white font-bold';
    if (value > 0.5) return 'bg-emerald-550/80 text-white';
    if (value > 0.3) return 'bg-emerald-500/40 text-emerald-100';
    if (value > 0) return 'bg-emerald-500/20 text-emerald-250';
    
    if (value < -0.6) return 'bg-rose-500 text-white font-bold';
    if (value < -0.3) return 'bg-rose-500/40 text-rose-100';
    if (value < 0) return 'bg-rose-500/20 text-rose-250';
    
    return 'bg-[#111822] text-slate-500';
  };

  // Check if a cell is part of the highlighted active cluster grouping
  const isCellClustered = (row: number, col: number) => {
    if (!isClusteringEnabled) return false;
    
    if (activeRegime === 'baseline') {
      // News (0) & Sent (3) cluster together
      if ((row === 0 || row === 3) && (col === 0 || col === 3)) return true;
      // Tech (2) & Flow (4) cluster together
      if ((row === 2 || row === 4) && (col === 2 || col === 4)) return true;
    } else if (activeRegime === 'macro') {
      // News (0) & Sent (3) & Macro (1) cluster
      if ([0, 1, 3].includes(row) && [0, 1, 3].includes(col)) return true;
      // Tech (2) & Flow (4) cluster
      if ([2, 4].includes(row) && [2, 4].includes(col)) return true;
    } else if (activeRegime === 'blackswan') {
      // Total lock-in: System-wide herd cluster (all indices except self or even with self)
      return true;
    }
    return false;
  };

  return (
    <div className="w-full flex justify-center flex-col h-full items-center" id="correlation-matrix-root">
      {/* Topology / Clustering Toolbar */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between w-full gap-4 mb-6 mt-2 px-2 border-b border-slate-800/60 pb-4">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer group select-none">
            <input 
              type="checkbox"
              className="accent-indigo-500 w-4 h-4 cursor-pointer"
              checked={isClusteringEnabled}
              onChange={(e) => setIsClusteringEnabled(e.target.checked)}
            />
            <span className={`text-[11px] font-mono tracking-widest uppercase transition-colors flex items-center gap-2 ${isClusteringEnabled ? 'text-indigo-400 font-bold' : 'text-slate-500 group-hover:text-slate-300'}`}>
              <Activity size={13} className={isClusteringEnabled ? 'text-indigo-400 animate-pulse' : 'text-slate-600'}/>
              Time-Series Clustering
            </span>
          </label>
        </div>

        {isClusteringEnabled && (
          <div className="flex flex-wrap items-center gap-1.5 bg-[#111822] p-1 rounded-lg border border-slate-800 font-mono text-[10px] w-full md:w-auto">
            <span className="text-[10px] text-slate-500 uppercase px-2 py-1 tracking-wider hidden sm:inline">Stress Level:</span>
            {[
              { id: 'baseline', label: 'STD BASELINE', color: 'border-emerald-500/25 border hover:bg-emerald-950/20 text-emerald-400' },
              { id: 'macro', label: 'MACRO SHOCK', color: 'border-yellow-500/25 border hover:bg-yellow-950/20 text-amber-400' },
              { id: 'blackswan', label: 'BLACK SWAN', color: 'border-rose-500/25 border hover:bg-rose-950/25 text-rose-500 font-bold' }
            ].map(reg => (
              <button
                key={reg.id}
                onClick={() => setActiveRegime(reg.id as Regime)}
                className={`flex-1 sm:flex-initial text-center px-3 py-1 rounded transition-all tracking-widest select-none ${
                  activeRegime === reg.id 
                    ? reg.id === 'baseline' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/40 font-bold shadow' :
                      reg.id === 'macro' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/40 font-bold shadow' :
                      'bg-rose-500/20 text-rose-450 border border-rose-500/50 font-black shadow animate-pulse'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {reg.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 w-full items-stretch mb-6">
        {/* Matrix Visualization Column */}
        <div className="md:col-span-7 bg-[#1A1F2B]/40 border border-slate-800/80 p-4 rounded-xl flex flex-col justify-center">
          <div className="w-full overflow-x-auto custom-scrollbar pt-2">
            <div className="min-w-[380px]">
              {/* Header row */}
              <div className="flex mb-2">
                <div className="w-20 shrink-0"></div>
                {AGENTS.map(agent => (
                  <div key={agent} className="flex-1 text-center pb-2">
                    <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest block transform -rotate-45 origin-bottom-left translate-x-3">
                      {agent.replace('Agent', '')}
                    </span>
                  </div>
                ))}
              </div>

              {/* Matrix rows */}
              {AGENTS.map((rowAgent, rowIndex) => (
                <div key={rowAgent} className="flex items-center mb-1.5">
                  <div className="w-20 shrink-0 pr-2.5 text-right">
                    <span className="text-[10px] font-mono text-slate-450 uppercase tracking-wider font-semibold">
                      {rowAgent.replace('Agent', '')}
                    </span>
                  </div>
                  {AGENTS.map((colAgent, colIndex) => {
                    const correlation = activeCorrelationData[rowIndex][colIndex];
                    const isHovered = hoveredCell?.row === rowIndex && hoveredCell?.col === colIndex;
                    const isCrossHovered = hoveredCell && (hoveredCell.row === rowIndex || hoveredCell.col === colIndex);
                    const isClustered = isCellClustered(rowIndex, colIndex);
                    
                    return (
                      <div 
                        key={colAgent} 
                        className="flex-1 px-1 relative"
                        onMouseEnter={() => setHoveredCell({ row: rowIndex, col: colIndex })}
                        onMouseLeave={() => setHoveredCell(null)}
                      >
                        <div className={`
                          h-11 rounded flex flex-col items-center justify-center font-mono text-xs transition-all cursor-pointer select-none
                          ${getCellColor(correlation)}
                          ${isHovered ? 'ring-2 ring-indigo-400 border-transparent z-10 relative scale-110 shadow-lg' : 'border border-slate-800/60'}
                          ${isCrossHovered && !isHovered ? 'opacity-30' : 'opacity-100'}
                          ${isClustered && rowIndex !== colIndex && !isHovered ? 'border-indigo-500/50 outline outline-1 outline-offset-1 outline-indigo-500/20' : ''}
                        `}>
                          <span>{correlation === 1 ? '-' : correlation >= 0 ? `+${correlation.toFixed(2)}` : correlation.toFixed(2)}</span>
                          
                          {/* Highlight Active Grouping Indicators */}
                          {isClustered && rowIndex !== colIndex && (
                            <span className="absolute bottom-0.5 right-[6px] w-1.5 h-1.5 bg-indigo-500/60 rounded-full animate-pulse"></span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Dynamic Clustered Dendrogram / Grouping Hierarchy Column */}
        <div className="md:col-span-5 border border-slate-800 p-5 rounded-xl bg-[#1A1F2B] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-slate-800/60 pb-3 mb-4">
              <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                <Network size={14} className="text-indigo-400 animate-pulse" />
                Active Cluster Groupings
              </span>
              <span className="text-[9px] font-mono text-slate-500 uppercase tracking-widest">
                {isClusteringEnabled ? 'TS-Clustered' : 'Standalone'}
              </span>
            </div>

            {isClusteringEnabled ? (
              <div className="space-y-4" id="cluster-groups-details">
                {/* Cluster Visual Cards */}
                {activeRegime === 'baseline' && (
                  <div className="space-y-3">
                    <p className="text-[10px] text-slate-450 leading-relaxed font-mono">
                      Couplings resolved under <strong className="text-emerald-400">Standard Volatility</strong>. Swarm behaves dualistically, with distinct public-sentiment and technical execution blocks.
                    </p>
                    
                    {/* Baseline Group 1 */}
                    <div className="bg-[#111822]/80 border border-slate-800 p-3 rounded-lg flex flex-col gap-1 text-[11px] font-mono">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-emerald-400 font-bold tracking-widest text-[10px]">■ L1 ALPHA: SENTIMENT CHAIN</span>
                        <span className="text-slate-500 text-[9px]">Mean Corr: +0.80</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-sm border border-indigo-500/25">NewsAgent</span>
                        <span className="text-slate-600">+</span>
                        <span className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-sm border border-indigo-500/25">SentAgent</span>
                      </div>
                    </div>

                    {/* Baseline Group 2 */}
                    <div className="bg-[#111822]/80 border border-slate-800 p-3 rounded-lg flex flex-col gap-1 text-[11px] font-mono">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-cyan-400 font-bold tracking-widest text-[10px]">■ L1 BETA: EXECUTION SPEED</span>
                        <span className="text-slate-500 text-[9px]">Mean Corr: +0.70</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="px-2 py-0.5 bg-cyan-900/15 text-cyan-400 rounded-sm border border-cyan-500/20">TechAgent</span>
                        <span className="text-slate-600">+</span>
                        <span className="px-2 py-0.5 bg-cyan-900/15 text-cyan-400 rounded-sm border border-cyan-500/20">FlowAgent</span>
                      </div>
                    </div>

                    {/* Baseline Independent */}
                    <div className="bg-[#111822]/40 border border-slate-800 p-2.5 rounded-lg flex items-center justify-between text-[10px] font-mono">
                      <span className="text-slate-500 uppercase tracking-widest">■ Quantitative Isolator:</span>
                      <span className="px-2 py-0.5 bg-slate-850 text-slate-400 rounded border border-slate-750">MacroAgent</span>
                    </div>
                  </div>
                )}

                {activeRegime === 'macro' && (
                  <div className="space-y-3">
                    <p className="text-[10px] text-slate-450 leading-relaxed font-mono">
                      Dynamic coupling detected under <strong className="text-amber-400">Macro Shock volatility</strong>. Narrative models begin grouping directly with structural monetary indices as interest-rate pressure spikes.
                    </p>

                    {/* Macro Group 1 */}
                    <div className="bg-[#111822]/80 border border-slate-800 p-3 rounded-lg flex flex-col gap-1 text-[11px] font-mono">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-amber-400 font-bold tracking-widest text-[10px]">■ CLUSTER ALPHA: NARRATIVE-MACRO SHOCK</span>
                        <span className="text-slate-500 text-[9px]">Mean Corr: +0.65</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-sm border border-indigo-500/25">NewsAgent</span>
                        <span className="text-slate-600">+</span>
                        <span className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-sm border border-indigo-500/25">SentAgent</span>
                        <span className="text-slate-600">+</span>
                        <span className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-sm border border-indigo-500/25">MacroAgent</span>
                      </div>
                    </div>

                    {/* Macro Group 2 */}
                    <div className="bg-[#111822]/80 border border-slate-800 p-3 rounded-lg flex flex-col gap-1 text-[11px] font-mono">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-cyan-400 font-bold tracking-widest text-[10px]">■ CLUSTER BETA: HIGH-SPEED MOMENTUM</span>
                        <span className="text-slate-500 text-[9px]">Mean Corr: +0.75</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="px-2 py-0.5 bg-cyan-900/15 text-cyan-400 rounded-sm border border-cyan-500/20">TechAgent</span>
                        <span className="text-slate-600">+</span>
                        <span className="px-2 py-0.5 bg-cyan-900/15 text-cyan-400 rounded-sm border border-cyan-500/20">FlowAgent</span>
                      </div>
                    </div>
                  </div>
                )}

                {activeRegime === 'blackswan' && (
                  <div className="space-y-3">
                    <div className="bg-rose-950/20 border border-rose-800/40 p-3 rounded-lg inline-flex items-center gap-2 w-full text-[10px] font-mono text-rose-400 select-none uppercase tracking-wide">
                      <AlertOctagon size={14} className="text-rose-500 shrink-0 animate-bounce" />
                      <div>
                        <span className="font-bold block">Herd Failure Protocol Engaged</span>
                        <span className="text-[8px] text-rose-500/80 block uppercase">Diversity factor drops from default 0.85 to 0.08.</span>
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-450 leading-relaxed font-mono">
                      Crisis consensus trajectory. Agent components show <span className="text-rose-400 underline decoration-rose-500/40">system-wide coupling collapsation</span>. Complete herd bias as components lose independence and echo identical signals.
                    </p>

                    {/* Herd Lock-In Cluster */}
                    <div className="bg-[#111822]/90 border border-rose-500/30 p-4.5 rounded-lg flex flex-col gap-2.5 text-[11px] font-mono relative overflow-hidden">
                      <span className="absolute top-0 right-0 w-24 h-1 bg-gradient-to-r from-transparent to-rose-500"></span>
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-rose-450 font-black tracking-widest text-[10px] flex items-center gap-1.5">
                          <AlertOctagon size={10} className="animate-ping" />
                          ★ UNIFIED SYSTEM HERD GROUP
                        </span>
                        <span className="text-rose-450 font-black text-[9px]">Mean Corr: +0.86</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 font-mono text-[9px]">
                        <span className="px-2 py-0.5 bg-rose-500/15 text-rose-450 rounded text-center border border-rose-500/30 font-bold">NEWS CHAIN</span>
                        <span className="px-2 py-0.5 bg-rose-500/15 text-rose-450 rounded text-center border border-rose-500/30 font-bold">MACRO REGIME</span>
                        <span className="px-2 py-0.5 bg-rose-500/15 text-rose-450 rounded text-center border border-rose-500/30 font-bold">TECHNICALS</span>
                        <span className="px-2 py-0.5 bg-rose-500/15 text-rose-450 rounded text-center border border-rose-500/30 font-bold">MARKET FLOW</span>
                      </div>
                      <p className="text-[8.5px] text-rose-400/80 italic text-center mt-1">
                        "Consensus Proposer automatically enforces a 50% max position trim target due to herding risk."
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-8 text-center text-slate-500 h-[220px] font-mono">
                <HelpCircle className="mb-2 text-slate-600" size={18} />
                <p className="text-[10px] leading-relaxed uppercase">Time-series clustering disabled. Turn on to view active mathematical coalitions and cluster dendrograms.</p>
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-slate-800/80 text-[9px] font-mono text-slate-500 uppercase tracking-wider flex items-center justify-between">
            <span>Adaptive Resolution Interval: {isClusteringEnabled ? '10 Sectors' : 'None'}</span>
            <span>Update Frequency: {isClusteringEnabled ? '1000ms' : 'Static'}</span>
          </div>
        </div>
      </div>

      {/* Relational Stats Drawer Footer */}
      <div className="flex flex-wrap items-center justify-between w-full p-4 border border-slate-800 rounded-lg bg-[#111822] select-none shadow-inner">
        <div className="flex items-center gap-2 mb-2 lg:mb-0">
          <Info size={14} className="text-indigo-400" />
          <span className="text-[10px] text-slate-450 font-mono tracking-widest uppercase">Pair relationship viewer:</span>
        </div>
        
        {hoveredCell && hoveredCell.row !== hoveredCell.col ? (
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="font-bold text-white">{AGENTS[hoveredCell.row]}</span>
              <Layers size={11} className="text-slate-600" />
              <span className="font-bold text-white">{AGENTS[hoveredCell.col]}</span>
            </div>
            <div className="h-4 w-px bg-slate-800"></div>
            <div>
              <span className="text-slate-500 text-[10px]">Co-Auth:</span>
              <span className="text-indigo-400 font-bold ml-1">{activeCoAuthorizations[hoveredCell.row][hoveredCell.col]}</span>
            </div>
            <div className="h-4 w-px bg-slate-800"></div>
            <div>
              <span className="text-slate-500 text-[10px]">Correlation:</span>
              <span className={`font-bold ml-1 ${activeCorrelationData[hoveredCell.row][hoveredCell.col] > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {activeCorrelationData[hoveredCell.row][hoveredCell.col] > 0 ? '+' : ''}{activeCorrelationData[hoveredCell.row][hoveredCell.col]}
              </span>
            </div>
            {isCellClustered(hoveredCell.row, hoveredCell.col) && (
              <>
                <div className="h-4 w-px bg-slate-800"></div>
                <div className="px-2 py-0.5 bg-indigo-500/10 text-indigo-405 border border-indigo-500/25 text-[8px] uppercase tracking-wider rounded font-bold animate-pulse">
                  Clustered Coalition
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-slate-550 font-mono italic uppercase tracking-wider">
            Hover over any correlation cell coordinates to analyze dual-agent telemetry profiles.
          </div>
        )}
      </div>
    </div>
  );
}
