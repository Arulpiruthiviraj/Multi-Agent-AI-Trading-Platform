const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const regex = /         <\/div>\n         <\/>\n         \}\)\(\)\}\n         <div className="flex justify-between items-center mt-3 border-t border-slate-800\/80 pt-3 px-1">/;

const searchStr = `         </div>
         </>
         )})()}
         <div className="flex justify-between items-center mt-3 border-t border-slate-800/80 pt-3 px-1">`;

const replacement = `         </div>
         </>
         )})()}
         
         {/* === COMPONENT: Position Size Optimizer (Kelly Criterion) === */}
         <div className="mt-6 bg-[#111822] rounded-lg border border-slate-800 p-4">
           <h4 className="text-[10px] uppercase font-mono tracking-widest text-slate-500 mb-4 flex items-center justify-between">
             <span className="flex items-center gap-2">
               <Crosshair size={14} className="text-emerald-500" />
               Position Size Optimizer (Kelly Criterion)
             </span>
             <span className="text-[9px] text-slate-600">PROBABILITY ENGINE</span>
           </h4>

           <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
             {[
               { symbol: "BTC/USD", winRate: 0.55, riskReward: 1.5 },
               { symbol: "ETH/USD", winRate: 0.45, riskReward: 2.0 },
               { symbol: "SOL/USD", winRate: 0.60, riskReward: 1.2 }
             ].map(asset => {
               const W = asset.winRate;
               const R = asset.riskReward;
               const kellyFraction = (W - ((1 - W) / R)) * 100;
               const halfKelly = kellyFraction / 2;
               
               return (
                 <div key={asset.symbol} className="bg-[#1a212d] border border-slate-800 rounded p-3 relative overflow-hidden transition-all hover:border-emerald-500/30">
                   <div className="absolute top-0 right-0 p-2 opacity-[0.03]">
                     <Target size={60} className={kellyFraction > 0 ? "text-emerald-500" : "text-rose-500"} />
                   </div>
                   <div className="flex justify-between items-center mb-3 z-10 relative">
                     <span className="text-sm font-bold text-slate-200 font-mono tracking-wider">{asset.symbol}</span>
                     <span className={\`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded \${kellyFraction > 0 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'}\`}>
                       {kellyFraction > 0 ? 'EDGE FOUND' : 'NO EDGE'}
                     </span>
                   </div>
                   
                   <div className="grid grid-cols-2 gap-2 mb-3 z-10 relative">
                     <div className="flex flex-col">
                       <span className="text-[9px] font-mono text-slate-500 tracking-wider">WIN RATE (W)</span>
                       <span className="text-xs font-mono text-slate-300 font-bold">{(W * 100).toFixed(1)}%</span>
                     </div>
                     <div className="flex flex-col">
                       <span className="text-[9px] font-mono text-slate-500 tracking-wider">RISK/REWARD (R)</span>
                       <span className="text-xs font-mono text-slate-300 font-bold">{R.toFixed(2)}</span>
                     </div>
                   </div>
                   
                   <div className="border-t border-slate-800/80 pt-3 z-10 relative">
                     <div className="flex justify-between items-end mb-1">
                       <span className="text-[10px] font-mono text-slate-400">Optimal (Full Kelly)</span>
                       <span className={\`text-sm font-mono font-bold \${kellyFraction > 0 ? 'text-emerald-400' : 'text-rose-400'}\`}>
                         {kellyFraction > 0 ? \`\${kellyFraction.toFixed(2)}%\` : '0.00%'}
                       </span>
                     </div>
                     <div className="w-full bg-slate-900 rounded-full h-1.5 mb-2 border border-slate-800">
                       <div className={\`h-full rounded-full \${kellyFraction > 0 ? 'bg-emerald-500' : 'bg-rose-500'}\`} style={{ width: \`\${Math.max(0, Math.min(100, kellyFraction))}%\` }}></div>
                     </div>
                     
                     <div className="flex justify-between items-center mt-2">
                       <span className="text-[9px] font-mono text-slate-500">Conservative (Half Kelly)</span>
                       <span className="text-[10px] font-mono text-indigo-400 font-bold">{halfKelly > 0 ? \`\${halfKelly.toFixed(2)}%\` : '0.00%'}</span>
                     </div>
                   </div>
                 </div>
               );
             })}
           </div>
           
           <div className="mt-4 text-[9px] font-mono text-slate-500 flex items-center justify-between border-t border-slate-800/80 pt-3">
              <span className="flex items-center gap-1"><Calculator size={10} className="text-slate-400" /> K = W - [(1 - W) / R]</span>
              <span>Allocations shown as % of total trading capital.</span>
           </div>
         </div>

         <div className="flex justify-between items-center mt-3 border-t border-slate-800/80 pt-3 px-1">`;

if (code.includes(searchStr)) {
  const newCode = code.replace(searchStr, replacement);
  fs.writeFileSync('src/App.tsx', newCode);
  console.log('Successfully inserted optimizer');
} else {
  console.log('String did not match');
}
