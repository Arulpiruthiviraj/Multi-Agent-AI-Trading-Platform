const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const s1 = `          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { symbol: "BTC/USD", atr: 1450.2, swingPercent: 2.25, risk: "High", trend: "up" },
              { symbol: "ETH/USD", atr: 85.4, swingPercent: 2.47, risk: "High", trend: "down" },
              { symbol: "SOL/USD", atr: 8.2, swingPercent: 5.89, risk: "Extreme", trend: "up" },
              { symbol: "AAPL", atr: 2.1, swingPercent: 1.13, risk: "Low", trend: "down" },
              { symbol: "TSLA", atr: 8.5, swingPercent: 4.85, risk: "Extreme", trend: "down" },
              { symbol: "NVDA", atr: 15.2, swingPercent: 1.78, risk: "Med", trend: "up" }
            ].map(asset => (
              <div key={asset.symbol} className={\`p-3 rounded border flex flex-col items-center justify-center text-center transition-all \${`;

const r1 = `          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { symbol: "BTC/USD", atr: 1450.2, sma: 1390.5, swingPercent: 2.25, risk: "High", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 1300 + (Math.random() * 200), sma: 1350 + (i * 3) })) },
              { symbol: "ETH/USD", atr: 85.4, sma: 88.2, swingPercent: 2.47, risk: "High", trend: "down", history: Array.from({length: 15}).map((_, i) => ({ atr: 95 - (Math.random() * 15), sma: 90 - (i * 0.5) })) },
              { symbol: "SOL/USD", atr: 8.2, sma: 5.5, swingPercent: 5.89, risk: "Extreme", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 5 + (Math.random() * 4), sma: 5 + (i * 0.2) })) },
              { symbol: "AAPL", atr: 2.1, sma: 2.4, swingPercent: 1.13, risk: "Low", trend: "down", history: Array.from({length: 15}).map((_, i) => ({ atr: 3 - (Math.random() * 1), sma: 2.8 - (i * 0.05) })) },
              { symbol: "TSLA", atr: 8.5, sma: 6.2, swingPercent: 4.85, risk: "Extreme", trend: "down", history: Array.from({length: 15}).map((_, i) => ({ atr: 6 + (Math.random() * 3), sma: 6 + (i * 0.15) })) },
              { symbol: "NVDA", atr: 15.2, sma: 14.8, swingPercent: 1.78, risk: "Med", trend: "up", history: Array.from({length: 15}).map((_, i) => ({ atr: 13 + (Math.random() * 3), sma: 14 + (i * 0.1) })) }
            ].map(asset => {
              const isAccelerating = asset.atr > asset.sma;
              return (
              <div key={asset.symbol} className={\`p-3 rounded border flex flex-col items-center justify-center text-center transition-all relative overflow-hidden \${`;

const s2 = `              </div>
            ))}
          </div>`;
const r2 = `              </div>
            )})}
          </div>`;

const s3 = `                <div className="flex items-center gap-1 mt-1.5 mb-1">
                  <span className="text-[10px] font-mono text-slate-400">ATR:</span>
                  <span className="text-[10px] font-mono text-white font-bold">{asset.atr.toFixed(1)}</span>
                </div>`;
const r3 = `                <div className="flex flex-col items-center gap-0.5 mt-1.5 mb-2 z-10">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] font-mono text-slate-400">ATR:</span>
                    <span className="text-[10px] font-mono text-white font-bold">{asset.atr.toFixed(1)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] font-mono text-slate-500">SMA:</span>
                    <span className={\`text-[9px] font-mono font-bold \${isAccelerating ? 'text-rose-400' : 'text-emerald-400'}\`}>{asset.sma.toFixed(1)}</span>
                    {isAccelerating ? <ArrowUp size={10} className="text-rose-400" /> : <ArrowDown size={10} className="text-emerald-400" />}
                  </div>
                </div>

                <div className="h-10 w-full mt-1 mb-2 z-10 pointer-events-none">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={asset.history}>
                      <Line type="monotone" dataKey="atr" stroke={asset.risk === 'Extreme' ? '#f43f5e' : asset.risk === 'High' ? '#f59e0b' : asset.risk === 'Med' ? '#eab308' : '#10b981'} strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="sma" stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>`;

const s4 = `                <span className={\`text-xs font-bold font-mono tracking-wide \${`;
const r4 = `                <span className={\`text-xs font-bold font-mono tracking-wide z-10 \${`;

const s5 = `                <span className={\`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded \${`;
const r5 = `                <span className={\`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded z-10 \${`;

let c = code;
c = c.replace(s1, r1);
c = c.replace(s2, r2);
c = c.replace(s3, r3);
c = c.replace(s4, r4);
c = c.replace(s5, r5);

if (c !== code) {
  fs.writeFileSync('src/App.tsx', c);
  console.log('Done!');
} else {
  console.log('No change');
}
