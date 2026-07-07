const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const regex = /         <h4 className="text-\[10px\] uppercase font-mono tracking-widest text-slate-500 mb-4 flex items-center justify-between">\s*<span className="flex items-center gap-2">\s*<Activity size=\{14\} className="text-amber-500" \/>\s*Real-Time Volatility Heatmap \(14-Period ATR\)\s*<\/span>\s*<span className="text-\[9px\] text-slate-600">PREDICTIVE SWING ANALYSIS<\/span>\s*<\/h4>\s*<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">/;

const replacement = `         <h4 className="text-[10px] uppercase font-mono tracking-widest text-slate-500 mb-4 flex items-center justify-between">
           <span className="flex items-center gap-2">
             <Activity size={14} className="text-amber-500" />
             Real-Time Volatility Heatmap (14-Period ATR)
           </span>
           <span className="text-[9px] text-slate-600">PREDICTIVE SWING ANALYSIS</span>
         </h4>
         
         <div className="mb-4 bg-rose-500/10 border border-rose-500/30 rounded p-3 flex items-start gap-2">
            <AlertTriangle size={14} className="text-rose-500 shrink-0 mt-0.5 animate-pulse" />
            <div>
               <span className="text-[10px] font-bold text-rose-400 font-mono tracking-wide uppercase">Accelerating Volatility Regime Detected</span>
               <p className="text-[9px] font-mono text-rose-300/70 mt-1 leading-relaxed">
                 Assets exhibiting &gt;10% increase in 14-period ATR SMA over the last hour: <strong className="text-rose-300">SOL/USD, TSLA</strong>. System recommends expanding stop-loss buffers to prevent noise-outs.
               </p>
            </div>
         </div>

         <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">`;

if (regex.test(code)) {
  const newCode = code.replace(regex, replacement);
  fs.writeFileSync('src/App.tsx', newCode);
  console.log('Successfully inserted alert');
} else {
  console.log('Regex did not match');
}
