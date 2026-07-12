const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const evidenceGraphUI = `

             {/* Evidence Graph / Consensus Engine */}
             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <div className="flex justify-between items-center mb-6 border-b border-slate-800 pb-4">
                 <div>
                   <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                     <Network size={16} className="text-fuchsia-400" />
                     Live Evidence Graph & Consensus
                   </h3>
                   <p className="text-[10px] text-slate-400 font-mono mt-1">Hierarchical tree tracking the execution of multiple specialized intelligence engines into a single verified consensus.</p>
                 </div>
                 <div className="bg-[#111822] px-4 py-2 rounded border border-slate-700 text-center">
                    <span className="text-[9px] uppercase font-mono text-slate-500 block mb-0.5">Final Consensus</span>
                    <span className="text-lg font-bold text-emerald-400">BUY (89%)</span>
                 </div>
               </div>
               
               <div className="font-mono text-xs overflow-x-auto">
                 <div className="min-w-[600px] py-4 pl-4 space-y-4">
                    <div className="flex items-center gap-3">
                       <span className="text-emerald-400 font-bold border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 rounded">BUY (89%)</span>
                       <span className="text-slate-500">─── Target: NVDA</span>
                    </div>
                    
                    <div className="pl-6 space-y-3 relative before:absolute before:left-[19px] before:top-[-10px] before:bottom-4 before:w-px before:bg-slate-700">
                       
                       <div className="flex items-center gap-4 relative">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-slate-300 w-36">Technical Score</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-emerald-400 font-bold">94% (Strong Buy)</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-slate-300 w-36">Momentum Engine</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-emerald-400 font-bold">87% (Accelerating)</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-slate-300 w-36">Volume Deviation</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-emerald-400 font-bold">82% (+2.4x Avg)</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-slate-300 w-36">News Sentiment</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-emerald-400 font-bold">89% (Highly Positive)</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-slate-300 w-36">Earnings Engine</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-emerald-400 font-bold">91% (+12% EPS Surprise)</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-slate-300 w-36">Market Regime</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-indigo-400 font-bold">Bullish</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-slate-300 w-36">Historical Match</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-indigo-400 font-bold">88% (842 similar setups)</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative mt-4">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-sky-400 w-36 flex items-center gap-1.5"><BrainCircuit size={12}/> Proposer Agent 1</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-emerald-400 font-bold">BUY (Confidence: 91%)</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-purple-400 w-36 flex items-center gap-1.5"><BrainCircuit size={12}/> Debate Agent 2</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-amber-400 font-bold">HOLD (Reason: Overbought)</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-rose-400 w-36 flex items-center gap-1.5"><ShieldAlert size={12}/> Risk Engine</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-emerald-400 font-bold">APPROVED (Risk: 1.2% Drawdown)</span>
                       </div>
                       
                       <div className="flex items-center gap-4 relative pt-2 border-t border-slate-800/80 mt-2 w-max">
                          <span className="absolute left-[-24px] top-1/2 w-4 h-px bg-slate-700"></span>
                          <span className="text-white w-36 font-bold uppercase tracking-widest">Final Consensus</span>
                          <span className="text-slate-500">............</span>
                          <span className="text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">EXECUTED BUY</span>
                       </div>

                    </div>
                 </div>
               </div>
             </div>
`;

code = code.replace(
  `               </div>\n             </div>\n          </div>\n        )}\n        \n{activeTab === "agents"`,
  `               </div>\n             </div>\n` + evidenceGraphUI + `          </div>\n        )}\n        \n{activeTab === "agents"`
);

fs.writeFileSync('src/App.tsx', code);
console.log("Patched App.tsx with Evidence Graph");
