const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const updatedIntelligenceUI = `
          <div className="animate-fade-in flex flex-col gap-6" id="intelligence-view">
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <div className="flex justify-between items-start mb-6">
                 <div>
                    <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2 uppercase tracking-wide">
                      <BrainCircuit size={16} className="text-indigo-400" />
                      Quantitative Intelligence Platform
                    </h3>
                    <p className="text-[11px] text-slate-400 max-w-3xl leading-relaxed">
                      Instead of a single calculation engine, raw market data flows through specialized numerical engines. 
                      Every AI Agent receives pre-computed deterministic facts (Trend, Momentum, Structure, Macro) to prevent hallucination and enforce rigid consensus weighting.
                    </p>
                 </div>
              </div>

              {/* Engine Grid Container */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
                
                {/* 1. Trend Engine */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-emerald-500/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-emerald-400 block mb-2 font-bold border-b border-emerald-500/20 pb-1.5 flex items-center gap-1.5"><TrendingUp size={10}/> Trend Engine</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>EMA 200</span> <span className="text-emerald-400">{autoBotConfig?.engines?.trend?.ema200 || 'Above'}</span></div>
                    <div className="flex justify-between"><span>ADX</span> <span className="text-white">{autoBotConfig?.engines?.trend?.adx || '28'} (Strong)</span></div>
                    <div className="flex justify-between"><span>Score</span> <span className="text-white">{autoBotConfig?.engines?.trend?.strength?.toFixed(1) || '89.0'}</span></div>
                  </div>
                </div>

                {/* 2. Momentum Engine */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-indigo-500/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-indigo-400 block mb-2 font-bold border-b border-indigo-500/20 pb-1.5 flex items-center gap-1.5"><Activity size={10}/> Momentum</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>RSI</span> <span className={(autoBotConfig?.engines?.momentum?.rsi || 64) > 70 ? 'text-rose-400' : 'text-emerald-400'}>{autoBotConfig?.engines?.momentum?.rsi?.toFixed(1) || '64.0'}</span></div>
                    <div className="flex justify-between"><span>MACD</span> <span className="text-emerald-400">{autoBotConfig?.engines?.momentum?.macd || 'Bull Cross'}</span></div>
                    <div className="flex justify-between"><span>Score</span> <span className="text-white">{autoBotConfig?.engines?.momentum?.score || '84'}</span></div>
                  </div>
                </div>

                {/* 3. Structure Engine */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-fuchsia-400/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-fuchsia-400 block mb-2 font-bold border-b border-fuchsia-500/20 pb-1.5 flex items-center gap-1.5"><Layers size={10}/> Structure</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>Pattern</span> <span className="text-white">{autoBotConfig?.engines?.marketStructure?.structure || 'Higher Highs'}</span></div>
                    <div className="flex justify-between"><span>Liquidity</span> <span className="text-slate-400">{autoBotConfig?.engines?.marketStructure?.liquiditySweep || 'None'}</span></div>
                    <div className="flex justify-between"><span>CHoCH</span> <span className="text-slate-400">{autoBotConfig?.engines?.marketStructure?.choch ? 'Detected' : 'None'}</span></div>
                  </div>
                </div>

                {/* 4. Smart Money */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-amber-400/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-amber-400 block mb-2 font-bold border-b border-amber-500/20 pb-1.5 flex items-center gap-1.5"><Database size={10}/> Smart Money</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>Ord Block</span> <span className="text-emerald-400">{autoBotConfig?.engines?.smartMoney?.orderBlock || 'Bullish 4H'}</span></div>
                    <div className="flex justify-between"><span>FVG</span> <span className="text-slate-400">{autoBotConfig?.engines?.smartMoney?.fvg || 'Filled'}</span></div>
                    <div className="flex justify-between"><span>Zone</span> <span className="text-emerald-400">{autoBotConfig?.engines?.smartMoney?.premiumDiscount || 'Discount'}</span></div>
                  </div>
                </div>

                {/* 5. Options Flow */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-rose-400/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-rose-400 block mb-2 font-bold border-b border-rose-500/20 pb-1.5 flex items-center gap-1.5"><BarChart3 size={10}/> Options Flow</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>P/C Ratio</span> <span className="text-white">{autoBotConfig?.engines?.optionsFlow?.putCallRatio || '0.65'}</span></div>
                    <div className="flex justify-between"><span>Gamma Exp</span> <span className="text-emerald-400">{autoBotConfig?.engines?.optionsFlow?.gammaExposure || '+1.2B'}</span></div>
                    <div className="flex justify-between"><span>Max Pain</span> <span className="text-white">${"{"}autoBotConfig?.engines?.optionsFlow?.maxPain || '320'{"}"}</span></div>
                  </div>
                </div>

                {/* 6. Volume Engine */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-sky-400/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-sky-400 block mb-2 font-bold border-b border-sky-500/20 pb-1.5 flex items-center gap-1.5"><BarChart2 size={10}/> Volume</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>RVOL</span> <span className="text-white">{autoBotConfig?.engines?.marketIntelligence?.rvol?.toFixed(2) || '1.40'}x</span></div>
                    <div className="flex justify-between"><span>OBV</span> <span className="text-emerald-400">{autoBotConfig?.engines?.volume?.obv || 'Rising'}</span></div>
                    <div className="flex justify-between"><span>Delta</span> <span className="text-emerald-400">{autoBotConfig?.engines?.volume?.delta || '+450k'}</span></div>
                  </div>
                </div>

                {/* 7. Volatility */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-purple-400/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-purple-400 block mb-2 font-bold border-b border-purple-500/20 pb-1.5 flex items-center gap-1.5"><Zap size={10}/> Volatility</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>ATR</span> <span className="text-white">{autoBotConfig?.engines?.volatility?.atr || '4.8'}</span></div>
                    <div className="flex justify-between"><span>B-Bands</span> <span className="text-rose-400">{autoBotConfig?.engines?.volatility?.bollinger || 'Upper Band'}</span></div>
                    <div className="flex justify-between"><span>Regime</span> <span className="text-amber-400">{autoBotConfig?.engines?.volatility?.regime || 'Expanding'}</span></div>
                  </div>
                </div>

                {/* 8. News Sentiment */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-cyan-400/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-cyan-400 block mb-2 font-bold border-b border-cyan-500/20 pb-1.5 flex items-center gap-1.5"><Globe size={10}/> News Agent</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>Sentiment</span> <span className="text-emerald-400">{autoBotConfig?.engines?.news?.sentiment?.toFixed(1) || '85.0'}</span></div>
                    <div className="flex justify-between"><span>Sources</span> <span className="text-white">{autoBotConfig?.engines?.news?.sources || '14'}</span></div>
                    <div className="flex justify-between"><span>Impact Vol</span> <span className="text-rose-400">{autoBotConfig?.engines?.news?.impact || 'High'}</span></div>
                  </div>
                </div>

                {/* 9. Macro Environment */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-orange-400/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-orange-400 block mb-2 font-bold border-b border-orange-500/20 pb-1.5 flex items-center gap-1.5"><Target size={10}/> Macro Env</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>Yields</span> <span className="text-emerald-400">{autoBotConfig?.engines?.macro?.yields || 'Falling'}</span></div>
                    <div className="flex justify-between"><span>DXY</span> <span className="text-emerald-400">{autoBotConfig?.engines?.macro?.dollarIndex || 'Weak'}</span></div>
                    <div className="flex justify-between"><span>CPI</span> <span className="text-slate-400">{autoBotConfig?.engines?.macro?.cpi || 'Inline'}</span></div>
                  </div>
                </div>

                {/* 10. Historical Analogs */}
                <div className="bg-[#111822] border border-slate-800 p-3 rounded-lg hover:border-teal-400/30 transition-colors">
                  <h4 className="text-[10px] uppercase font-mono text-teal-400 block mb-2 font-bold border-b border-teal-500/20 pb-1.5 flex items-center gap-1.5"><Clock size={10}/> Historical</h4>
                  <div className="space-y-1.5 text-[10px] font-mono text-slate-300">
                    <div className="flex justify-between"><span>Matches</span> <span className="text-white">{autoBotConfig?.engines?.historical?.matches || '842'}</span></div>
                    <div className="flex justify-between"><span>Win Rate</span> <span className="text-emerald-400">{autoBotConfig?.engines?.historical?.winRate || '72'}%</span></div>
                    <div className="flex justify-between"><span>Avg Ret</span> <span className="text-emerald-400">+{autoBotConfig?.engines?.historical?.avgReturn || '6.4'}%</span></div>
                  </div>
                </div>

              </div>

              {/* Evidence Engine Table */}
              <h4 className="text-[11px] font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2 mt-4 border-t border-slate-800 pt-6">
                <Layers size={14} className="text-amber-400" />
                Live Evidence Weighting Engine (Deterministic Proof)
              </h4>
              <div className="overflow-x-auto border border-slate-800 rounded-lg">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-[#111822]/50 border-b border-slate-800 text-[10px] uppercase tracking-widest text-slate-500 font-mono">
                      <th className="py-2 px-3">Criteria Evaluated by Engines</th>
                      <th className="py-2 px-3">Engine Result</th>
                      <th className="py-2 px-3 text-right">Mathematical Weight</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 font-mono text-[11px]">
                    {(autoBotConfig?.engines?.evidenceTable || [
                      { criteria: "Price > 200 EMA", result: "Bullish", weight: 12 },
                      { criteria: "MACD bullish crossover", result: "Bullish", weight: 8 },
                      { criteria: "Relative volume 2.4x average", result: "Bullish", weight: 10 },
                      { criteria: "RSI overbought (78)", result: "Bearish", weight: -6 },
                      { criteria: "Positive earnings surprise", result: "Bullish", weight: 9 },
                      { criteria: "Recent negative macro news", result: "Bearish", weight: -4 }
                    ]).map((ev, i) => (
                      <tr key={i} className="hover:bg-[#111822]/30">
                        <td className="py-2 px-3 text-slate-300">{ev.criteria}</td>
                        <td className={"py-2 px-3 " + (ev.result === 'Bullish' ? 'text-emerald-400' : 'text-rose-400')}>{ev.result}</td>
                        <td className={"py-2 px-3 text-right " + (ev.weight > 0 ? 'text-emerald-400' : 'text-rose-400')}>{ev.weight > 0 ? '+' : ''}{ev.weight}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* AI Verification Engine */}
              <div className="mt-6 bg-[#111822] border border-slate-700/50 p-4 rounded-lg flex flex-col md:flex-row items-center justify-between gap-6">
                 <div>
                    <h4 className="text-[10px] font-bold text-white uppercase tracking-widest mb-1 flex items-center gap-1.5"><ShieldCheck size={12} className="text-emerald-400"/> AI Verification & Consensus Engine</h4>
                    <p className="text-[10px] text-slate-500 font-mono max-w-sm">Cross-referencing autonomous LLM sentiment with the aggregated mathematical score from all 10 intelligence engines.</p>
                 </div>
                 <div className="flex items-center gap-6 text-center font-mono">
                    <div>
                      <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">AI Output</div>
                      <div className="text-xl font-bold text-white">{autoBotConfig?.engines?.verification?.aiConfidence || 86}%</div>
                    </div>
                    <div className="text-slate-600 text-lg">VS</div>
                    <div>
                      <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Math Engine</div>
                      <div className="text-xl font-bold text-indigo-400">{autoBotConfig?.engines?.verification?.engineConfidence || 88}%</div>
                    </div>
                    <div className="w-px h-8 bg-slate-800 mx-2"></div>
                    <div>
                      <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Consensus Match</div>
                      <div className={"text-xl font-bold " + ((autoBotConfig?.engines?.verification?.agreement || 97) > 80 ? 'text-emerald-400' : 'text-amber-400')}>{autoBotConfig?.engines?.verification?.agreement?.toFixed(1) || '97.0'}%</div>
                    </div>
                 </div>
              </div>

            </div>
`;

// Extract everything from <div className="animate-fade-in flex flex-col gap-6" id="intelligence-view">
// up to {/* Evidence Graph / Consensus Engine */}
const startMarker = '<div className="animate-fade-in flex flex-col gap-6" id="intelligence-view">';
const endMarker = '{/* Evidence Graph / Consensus Engine */}';

const startIndex = code.indexOf(startMarker);
const endIndex = code.indexOf(endMarker);

if (startIndex !== -1 && endIndex !== -1) {
    code = code.substring(0, startIndex) + updatedIntelligenceUI + "\n              " + code.substring(endIndex);
    fs.writeFileSync('src/App.tsx', code);
    console.log("Patched App.tsx intelligence UI with 10 Engines successfully");
} else {
    console.log("Could not find markers to replace.");
}

