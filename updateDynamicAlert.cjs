const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const searchRegex = /         <div className="mb-4 bg-rose-500\/10 border border-rose-500\/30 rounded p-3 flex items-start gap-2">[\s\S]*?<\/div>\s*<\/div>\s*<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">/;

const searchArrayRegex = /           \{\[\s*\{ symbol: "BTC\/USD"[\s\S]*?\}\s*\]/;

const newArrayCode = `           {const assets = [
             { symbol: "BTC/USD", atr: 1450.2, sma: 1390.5, swingPercent: 2.25, risk: "High", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 1300 + (Math.random() * 200), sma: 1350 + (i * 3) })) },
             { symbol: "ETH/USD", atr: 85.4, sma: 88.2, swingPercent: 2.47, risk: "High", trend: "down", history: Array.from({length: 15}).map((_, i) => ({ atr: 95 - (Math.random() * 15), sma: 90 - (i * 0.5) })) },
             { symbol: "SOL/USD", atr: 8.2, sma: 5.5, swingPercent: 5.89, risk: "Extreme", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 5 + (Math.random() * 4), sma: 4.8 + (i * 0.05) })) },
             { symbol: "AAPL", atr: 2.1, sma: 2.4, swingPercent: 1.13, risk: "Low", trend: "down", history: Array.from({length: 15}).map((_, i) => ({ atr: 3 - (Math.random() * 1), sma: 2.8 - (i * 0.05) })) },
             { symbol: "TSLA", atr: 8.5, sma: 6.2, swingPercent: 4.85, risk: "Extreme", trend: "down", history: Array.from({length: 15}).map((_, i) => ({ atr: 6 + (Math.random() * 3), sma: 5.4 + (i * 0.06) })) },
             { symbol: "NVDA", atr: 15.2, sma: 14.8, swingPercent: 1.78, risk: "Med", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 13 + (Math.random() * 3), sma: 14 + (i * 0.1) })) }
           ];
           const acceleratingAssets = assets.filter(a => a.sma > a.history[0].sma * 1.1).map(a => a.symbol);
           
           return (
            <>
             {acceleratingAssets.length > 0 && (
               <div className="mb-4 bg-rose-500/10 border border-rose-500/30 rounded p-3 flex items-start gap-2">
                 <AlertTriangle size={14} className="text-rose-500 shrink-0 mt-0.5 animate-pulse" />
                 <div>
                   <span className="text-[10px] font-bold text-rose-400 font-mono tracking-wide uppercase">Accelerating Volatility Regime Detected</span>
                   <p className="text-[9px] font-mono text-rose-300/70 mt-1 leading-relaxed">
                     Assets exhibiting &gt;10% increase in 14-period ATR SMA over the last hour: <strong className="text-rose-300">{acceleratingAssets.join(', ')}</strong>. System recommends expanding stop-loss buffers to prevent noise-outs.
                   </p>
                 </div>
               </div>
             )}
             <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
               {assets`;

if (code.includes('Assets exhibiting &gt;10% increase')) {
  // Let's replace the hardcoded alert banner with dynamic one.
  const regex1 = /         <div className="mb-4 bg-rose-500\/10 border border-rose-500\/30 rounded p-3 flex items-start gap-2">[\s\S]*?<\/div>\s*<\/div>/;
  let code1 = code.replace(regex1, ''); // remove hardcoded alert
  
  const arrayStartStr = `         <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">\n           {[\n             { symbol: "BTC/USD",`;
  const arrayStartReplacement = `         {(() => {
           const assets = [
             { symbol: "BTC/USD",`;
             
  if (code1.includes(arrayStartStr)) {
    code1 = code1.replace(arrayStartStr, arrayStartReplacement);
    
    // now we need to replace the end of array
    // from ].map(asset => { to ]; ...
    const arrayEndStr = `             { symbol: "NVDA", atr: 15.2, sma: 14.8, swingPercent: 1.78, risk: "Med", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 13 + (Math.random() * 3), sma: 14 + (i * 0.1) })) }\n           ].map(asset => {`;
    
    const arrayEndReplacement = `             { symbol: "NVDA", atr: 15.2, sma: 14.8, swingPercent: 1.78, risk: "Med", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 13 + (Math.random() * 3), sma: 14 + (i * 0.1) })) }
           ];
           const acceleratingAssets = assets.filter(a => a.sma > a.history[0].sma * 1.1).map(a => a.symbol);
           
           return (
            <>
             {acceleratingAssets.length > 0 && (
               <div className="mb-4 bg-rose-500/10 border border-rose-500/30 rounded p-3 flex items-start gap-2">
                 <AlertTriangle size={14} className="text-rose-500 shrink-0 mt-0.5 animate-pulse" />
                 <div>
                   <span className="text-[10px] font-bold text-rose-400 font-mono tracking-wide uppercase">Accelerating Volatility Regime Detected</span>
                   <p className="text-[9px] font-mono text-rose-300/70 mt-1 leading-relaxed">
                     Assets exhibiting &gt;10% increase in 14-period ATR SMA over the last hour: <strong className="text-rose-300">{acceleratingAssets.join(', ')}</strong>. System recommends expanding stop-loss buffers to prevent noise-outs.
                   </p>
                 </div>
               </div>
             )}
             <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
               {assets.map(asset => {`;
               
    code1 = code1.replace(arrayEndStr, arrayEndReplacement);
    
    // We need to add the closing </>; after the map
    const mapEndStr = `               </span>\n             </div>\n           )})}\n         </div>`;
    const mapEndReplacement = `               </span>\n             </div>\n           )})}\n         </div>\n         </>\n         )})()}`;
    
    code1 = code1.replace(mapEndStr, mapEndReplacement);
    
    // Let's modify the SOL and TSLA history so they trigger the >10% condition
    code1 = code1.replace(
      `{ symbol: "SOL/USD", atr: 8.2, sma: 5.5, swingPercent: 5.89, risk: "Extreme", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 5 + (Math.random() * 4), sma: 5 + (i * 0.2) })) }`,
      `{ symbol: "SOL/USD", atr: 8.2, sma: 5.5, swingPercent: 5.89, risk: "Extreme", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 5 + (Math.random() * 4), sma: 4.8 + (i * 0.05) })) }`
    );
    
    code1 = code1.replace(
      `{ symbol: "TSLA", atr: 8.5, sma: 6.2, swingPercent: 4.85, risk: "Extreme", trend: "down", history: Array.from({length: 15}).map((_, i) => ({ atr: 6 + (Math.random() * 3), sma: 6 + (i * 0.15) })) }`,
      `{ symbol: "TSLA", atr: 8.5, sma: 6.2, swingPercent: 4.85, risk: "Extreme", trend: "down", history: Array.from({length: 15}).map((_, i) => ({ atr: 6 + (Math.random() * 3), sma: 5.4 + (i * 0.06) })) }`
    );

    fs.writeFileSync('src/App.tsx', code1);
    console.log('Successfully applied dynamic updates');
  } else {
    console.log('Array start not found');
  }
}
