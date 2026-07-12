import fs from 'fs';

let lines = fs.readFileSync('src/App.tsx', 'utf8').split('\n');

const newUI = `
        {activeTab === "audit" && (
          <div className="animate-fade-in flex flex-col gap-6" id="observability-view">
            
            {/* Header / Replay Controls */}
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                 <div>
                    <h3 className="text-sm font-bold text-white mb-1 flex items-center gap-2 uppercase tracking-wide">
                      <Activity size={16} className="text-emerald-400" />
                      Observability & Trade Tracing
                    </h3>
                    <p className="text-[11px] text-slate-400 max-w-3xl leading-relaxed font-mono">
                      End-to-end distributed tracing for AI execution. Inspect individual agent payloads, engine latency, and consensus networks.
                    </p>
                 </div>
                 <div className="flex items-center gap-3 bg-[#111822] border border-slate-700 p-2 rounded-lg">
                    <div className="px-3 border-r border-slate-700">
                      <div className="text-[9px] uppercase text-slate-500 font-bold tracking-widest mb-0.5">Active Trace ID</div>
                      <div className="text-xs font-mono text-indigo-400">TRD-20260711-000145</div>
                    </div>
                    <div className="flex items-center gap-1.5 px-2">
                       <button className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors" title="Rewind">
                         <SkipBack size={14} />
                       </button>
                       <button className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold uppercase tracking-widest rounded hover:bg-emerald-500/20 transition-colors flex items-center gap-1.5">
                         <Play size={12} fill="currentColor"/> Replay Trace
                       </button>
                       <button className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition-colors" title="Forward">
                         <SkipForward size={14} />
                       </button>
                    </div>
                 </div>
              </div>
            </div>

            {/* Horizontal Timeline */}
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500 mb-6 font-mono">Execution Timeline</h4>
               <div className="flex items-center justify-between text-[10px] font-mono w-full overflow-x-auto pb-4">
                 <div className="flex flex-col items-center gap-2 min-w-[80px]">
                   <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center text-emerald-400"><Check size={12} /></div>
                   <span className="text-slate-300">Market Scan</span>
                   <span className="text-slate-500">85ms</span>
                 </div>
                 <div className="h-px bg-slate-700 flex-1 min-w-[30px]"></div>
                 
                 <div className="flex flex-col items-center gap-2 min-w-[80px]">
                   <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center text-emerald-400"><Check size={12} /></div>
                   <span className="text-slate-300">Data Collect</span>
                   <span className="text-slate-500">240ms</span>
                 </div>
                 <div className="h-px bg-slate-700 flex-1 min-w-[30px]"></div>

                 <div className="flex flex-col items-center gap-2 min-w-[80px]">
                   <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center text-emerald-400"><Check size={12} /></div>
                   <span className="text-slate-300">Calc Engine</span>
                   <span className="text-slate-500">120ms</span>
                 </div>
                 <div className="h-px bg-slate-700 flex-1 min-w-[30px]"></div>

                 <div className="flex flex-col items-center gap-2 min-w-[80px]">
                   <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center text-emerald-400"><Check size={12} /></div>
                   <span className="text-slate-300">News Pipe</span>
                   <span className="text-slate-500">410ms</span>
                 </div>
                 <div className="h-px bg-slate-700 flex-1 min-w-[30px]"></div>

                 <div className="flex flex-col items-center gap-2 min-w-[80px] bg-indigo-500/10 p-2 rounded border border-indigo-500/20 shadow-[0_0_15px_rgba(99,102,241,0.1)] relative top-[-8px]">
                   <div className="w-6 h-6 rounded-full bg-indigo-500 flex items-center justify-center text-white"><BrainCircuit size={12} /></div>
                   <span className="text-indigo-400 font-bold">AI Debate</span>
                   <span className="text-slate-400">3.2s</span>
                 </div>
                 <div className="h-px bg-slate-700 flex-1 min-w-[30px]"></div>

                 <div className="flex flex-col items-center gap-2 min-w-[80px]">
                   <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center text-emerald-400"><Check size={12} /></div>
                   <span className="text-slate-300">Consensus</span>
                   <span className="text-slate-500">45ms</span>
                 </div>
                 <div className="h-px bg-slate-700 flex-1 min-w-[30px]"></div>

                 <div className="flex flex-col items-center gap-2 min-w-[80px]">
                   <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center text-emerald-400"><Check size={12} /></div>
                   <span className="text-slate-300">Risk Check</span>
                   <span className="text-slate-500">20ms</span>
                 </div>
                 <div className="h-px bg-slate-700 flex-1 min-w-[30px]"></div>

                 <div className="flex flex-col items-center gap-2 min-w-[80px]">
                   <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500 flex items-center justify-center text-emerald-400"><Check size={12} /></div>
                   <span className="text-slate-300 text-center">Order Exec<br/><span className="text-[8px] text-slate-500">Alpaca</span></span>
                 </div>
               </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
               
               {/* Decision Provenance Graph */}
               <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
                 <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500 mb-4 font-mono flex items-center gap-2">
                   <Network size={14}/> Decision Provenance
                 </h4>
                 <div className="bg-[#111822] p-4 rounded border border-slate-800 font-mono text-[10px] text-slate-400 whitespace-pre leading-[1.6] overflow-x-auto">
<span className="text-emerald-400 font-bold">BUY NVDA</span> (Score: 88%)
│
├── <span className="text-white">Calculation Engine (40%)</span>
│   ├── Trend Score: <span className="text-emerald-400">95% (Bullish)</span>
│   ├── Momentum Score: <span className="text-emerald-400">82% (Strong)</span>
│   ├── Volume Score: <span className="text-emerald-400">91% (2.41x)</span>
│   └── Market Structure: <span className="text-white">Higher Highs</span>
│
├── <span className="text-white">News Intelligence (15%)</span>
│   ├── Reuters: <span className="text-emerald-400">Positive AI Demand</span>
│   ├── Bloomberg: <span className="text-emerald-400">Analyst Upgrade</span>
│   └── Earnings Analysis: <span className="text-white">Awaiting</span>
│
├── <span className="text-indigo-400 font-bold">AI Council (25%)</span>
│   ├── ChatGPT: <span className="text-emerald-400 font-bold">BUY</span> (Conf: 89%)
│   ├── Claude: <span className="text-emerald-400 font-bold">BUY</span> (Conf: 85%)
│   └── Gemini: <span className="text-amber-400 font-bold">HOLD</span> (Conf: 72%)
│
├── <span className="text-white">Historical Similarity (10%)</span>
│   └── Match: <span className="text-emerald-400">Pattern 84A (72% Win Rate)</span>
│
└── <span className="text-rose-400 font-bold">Risk Engine (10%)</span>
    ├── ATR Volatility: <span className="text-white">3.8</span>
    └── Position Sizing: <span className="text-emerald-400">Approved ($100)</span>
                 </div>
               </div>

               {/* Agent Debate Logs */}
               <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
                 <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500 mb-4 font-mono flex items-center gap-2">
                   <MessageSquare size={14}/> LLM Council Debate Logs
                 </h4>
                 
                 <div className="space-y-4 font-mono">
                    <div className="bg-[#111822] border-l-2 border-emerald-500 p-3 rounded-r">
                      <div className="flex justify-between items-center mb-2">
                         <span className="text-xs font-bold text-emerald-400">ChatGPT (Proposer)</span>
                         <span className="text-[9px] text-slate-500">Latency: 3.2s | Tokens: 4,210</span>
                      </div>
                      <p className="text-[10px] text-slate-300">
                        <span className="text-slate-500 uppercase">Recommendation:</span> <span className="text-emerald-400 font-bold">BUY</span> (89%)<br/>
                        <span className="text-slate-500 uppercase">Reasoning:</span> Strong momentum confirmed by Volume Engine. Positive AI demand news outweighs minor overbought conditions. Above 200 EMA.
                      </p>
                    </div>

                    <div className="bg-[#111822] border-l-2 border-emerald-500 p-3 rounded-r">
                      <div className="flex justify-between items-center mb-2">
                         <span className="text-xs font-bold text-emerald-400">Claude (Verifier)</span>
                         <span className="text-[9px] text-slate-500">Latency: 2.8s | Tokens: 3,840</span>
                      </div>
                      <p className="text-[10px] text-slate-300">
                        <span className="text-slate-500 uppercase">Recommendation:</span> <span className="text-emerald-400 font-bold">BUY</span> (85%)<br/>
                        <span className="text-slate-500 uppercase">Concern:</span> Volume slightly declining on intra-day 15m chart.<br/>
                        <span className="text-slate-500 uppercase">Risk:</span> Medium.
                      </p>
                    </div>

                    <div className="bg-[#111822] border-l-2 border-amber-500 p-3 rounded-r">
                      <div className="flex justify-between items-center mb-2">
                         <span className="text-xs font-bold text-amber-400">Gemini (Devil's Advocate)</span>
                         <span className="text-[9px] text-slate-500">Latency: 4.1s | Tokens: 4,512</span>
                      </div>
                      <p className="text-[10px] text-slate-300">
                        <span className="text-slate-500 uppercase">Recommendation:</span> <span className="text-amber-400 font-bold">HOLD</span> (72%)<br/>
                        <span className="text-slate-500 uppercase">Disagreement:</span> Potential resistance nearby at 183.50.<br/>
                        <span className="text-slate-500 uppercase">Evidence:</span> Past rejection 3 times at this exact Fibonacci retracement level in the last 6 months.
                      </p>
                    </div>
                 </div>
               </div>

            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
               {/* News Pipeline */}
               <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
                 <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500 mb-4 font-mono flex items-center gap-2">
                   <Filter size={14}/> News Intelligence Pipeline
                 </h4>
                 <div className="space-y-2 font-mono text-[10px]">
                    <div className="flex justify-between items-center p-2 bg-[#111822] rounded border border-slate-800">
                       <span className="text-slate-400">Raw Articles Received</span>
                       <span className="text-white font-bold">132</span>
                    </div>
                    <div className="flex justify-center text-slate-600 py-0.5"><ArrowDown size={12}/></div>
                    <div className="flex justify-between items-center p-2 bg-[#111822] rounded border border-slate-800">
                       <span className="text-slate-400">Duplicate / Spam Removal</span>
                       <span className="text-emerald-400 font-bold">30</span>
                    </div>
                    <div className="flex justify-center text-slate-600 py-0.5"><ArrowDown size={12}/></div>
                    <div className="p-3 bg-[#111822] rounded border border-slate-800">
                       <div className="flex justify-between items-center mb-2">
                         <span className="text-slate-400">Categorization</span>
                         <span className="text-indigo-400">AI / Tech / Hardware</span>
                       </div>
                       <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden flex">
                          <div className="bg-emerald-500 h-full" style={{ width: '83%' }}></div>
                          <div className="bg-slate-500 h-full" style={{ width: '6%' }}></div>
                          <div className="bg-rose-500 h-full" style={{ width: '11%' }}></div>
                       </div>
                       <div className="flex justify-between mt-2 text-[9px]">
                          <span className="text-emerald-400">83% Positive</span>
                          <span className="text-slate-500">6% Neutral</span>
                          <span className="text-rose-400">11% Negative</span>
                       </div>
                    </div>
                    <div className="flex justify-center text-slate-600 py-0.5"><ArrowDown size={12}/></div>
                    <div className="flex justify-between items-center p-2 bg-indigo-500/10 border border-indigo-500/20 rounded">
                       <span className="text-indigo-400 font-bold uppercase">Impact Estimation</span>
                       <span className="text-emerald-400 font-bold">HIGH (NVIDIA infra upgrades)</span>
                    </div>
                 </div>
               </div>

               {/* Risk & Execution Logs */}
               <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
                 <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500 mb-4 font-mono flex items-center gap-2">
                   <ShieldCheck size={14}/> Risk & Execution Verification
                 </h4>
                 
                 <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="bg-[#111822] p-3 rounded border border-slate-800 font-mono text-[10px]">
                       <h5 className="text-slate-500 uppercase mb-2 border-b border-slate-800 pb-1">Risk Engine</h5>
                       <div className="space-y-1.5">
                         <div className="flex justify-between"><span className="text-slate-400">Risk Score</span><span className="text-white">18 / 30</span></div>
                         <div className="flex justify-between"><span className="text-slate-400">Pass</span><span className="text-emerald-400 font-bold">Yes</span></div>
                         <div className="flex justify-between"><span className="text-slate-400">Position Size</span><span className="text-white">$100 (0.42 sh)</span></div>
                         <div className="flex justify-between"><span className="text-slate-400">Stop Loss</span><span className="text-rose-400">2% (ATR-based)</span></div>
                         <div className="flex justify-between"><span className="text-slate-400">Take Profit</span><span className="text-emerald-400">5%</span></div>
                       </div>
                    </div>

                    <div className="bg-[#111822] p-3 rounded border border-slate-800 font-mono text-[10px]">
                       <h5 className="text-slate-500 uppercase mb-2 border-b border-slate-800 pb-1">Execution Engine</h5>
                       <div className="space-y-1.5">
                         <div className="flex justify-between"><span className="text-slate-400">Broker</span><span className="text-sky-400">Alpaca</span></div>
                         <div className="flex justify-between"><span className="text-slate-400">Order</span><span className="text-emerald-400 font-bold">BUY MKT</span></div>
                         <div className="flex justify-between"><span className="text-slate-400">Status</span><span className="text-emerald-400 font-bold">FILLED</span></div>
                         <div className="flex justify-between"><span className="text-slate-400">Fill Price</span><span className="text-white">182.44</span></div>
                         <div className="flex justify-between"><span className="text-slate-400">Slippage</span><span className="text-rose-400">0.01%</span></div>
                       </div>
                    </div>
                 </div>

                 <div className="bg-emerald-500/10 border border-emerald-500/20 p-3 rounded text-[10px] font-mono flex items-center justify-between">
                    <div>
                      <span className="text-emerald-400 font-bold block mb-0.5">TRADE COMPLETED SUCCESSFULLY</span>
                      <span className="text-slate-400">Total Pipeline Latency: 2.83 seconds</span>
                    </div>
                    <button className="px-3 py-1 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 rounded border border-emerald-500/30 transition-colors uppercase font-bold tracking-wider">
                      Export Trace
                    </button>
                 </div>
               </div>
            </div>

          </div>
        )}
`;

let startIdx = -1;
let endIdx = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('{activeTab === "audit" && (')) {
    startIdx = i;
  }
  // Keep looking for the end block of the audit view.
  if (startIdx !== -1 && lines[i].includes('{activeTab === "opportunities" && (')) {
    endIdx = i - 1; 
    // Go backwards to find the closing } for the activeTab block
    while (!lines[endIdx].includes(')}')) {
        endIdx--;
    }
    break;
  }
}

if (startIdx !== -1 && endIdx !== -1) {
  const newLines = [
    ...lines.slice(0, startIdx),
    newUI,
    ...lines.slice(endIdx + 1)
  ];
  fs.writeFileSync('src/App.tsx', newLines.join('\n'));
  console.log("Success");
} else {
  console.log("Failed to find boundaries", startIdx, endIdx);
}
