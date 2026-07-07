const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

const docTabRegex = /\{activeTab === "documentation" && \([\s\S]*?\n        \)\}/;

const newDocContent = `{activeTab === "documentation" && (
          <div className="animate-fade-in flex flex-col gap-6" id="doc-view">
             <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
                
                {/* 5 - STRATEGIES (Assumed from Image 1) */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-4 flex items-center gap-2">
                    <Layers size={18} className="text-emerald-400" />
                    5 - STRATEGIES
                  </h2>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                       <div className="flex justify-between items-center mb-2">
                         <h3 className="text-emerald-400 font-bold text-xs uppercase tracking-wide">VOLATILITY_REGIME</h3>
                         <span className="text-[9px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono uppercase tracking-wider">REGIME</span>
                       </div>
                       <p className="text-white text-sm font-bold mb-1">Volatility Regime</p>
                       <p className="text-xs text-slate-400">Prefers entries in low-vol regimes; signals caution in high-vol regimes.</p>
                    </div>
                    <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                       <div className="flex justify-between items-center mb-2">
                         <h3 className="text-emerald-400 font-bold text-xs uppercase tracking-wide">BOLLINGER_BANDS</h3>
                         <span className="text-[9px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono uppercase tracking-wider">MEAN-REVERSION</span>
                       </div>
                       <p className="text-white text-sm font-bold mb-1">Bollinger Bands</p>
                       <p className="text-xs text-slate-400">Mean reversion on 20-day Bollinger Bands (20): buy lower band, sell upper band.</p>
                    </div>
                  </div>
                </div>

                {/* 6 - BROKER ROUTING */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-1 flex items-center gap-2">
                    <Network size={18} className="text-sky-400" />
                    6 - BROKER ROUTING
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">The router picks a broker per symbol. Paper safety differs by broker.</p>
                  
                  <div className="bg-slate-900/50 p-5 rounded-xl border border-slate-800 flex flex-col items-center">
                    <div className="bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg mb-2">Order for symbol</div>
                    <div className="text-slate-500 mb-2 font-mono text-[10px]">↓</div>
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 w-full">
                       <div className="border border-emerald-500/30 rounded-lg p-4 bg-emerald-500/5">
                         <h4 className="text-emerald-400 font-bold text-xs mb-1">US symbols → Alpaca</h4>
                         <p className="text-xs text-slate-300">Defaults to the paper-api endpoint — safe to run live. Real-money orders require both paperTradingOnly=false and ALLOW_LIVE_TRADING=true.</p>
                       </div>
                       <div className="border border-rose-500/30 rounded-lg p-4 bg-rose-500/5">
                         <h4 className="text-rose-400 font-bold text-xs mb-1">CDN (.TO/.V) → Questrade</h4>
                         <p className="text-xs text-slate-300">Questrade has no paper environment — every order is real money, so it is hard-gated. In paper mode the trade stays simulated in the in-memory ledger.</p>
                       </div>
                    </div>
                    <div className="mt-4 text-[10px] text-slate-400 font-mono text-center">
                      Refresh tokens rotate on every use and are persisted to data/questrade_token.json so restarts don't lock you out.
                    </div>
                  </div>
                </div>

                {/* 7 - THE LEARNING ENGINE */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-1 flex items-center gap-2">
                    <BrainCircuit size={18} className="text-amber-400" />
                    7 - THE LEARNING ENGINE
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">Two independent online learners adapt the system from realized results.</p>
                  
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
                    <div className="bg-slate-900/50 p-5 rounded-xl border border-slate-800">
                      <h4 className="text-amber-400 font-bold text-xs mb-3">Strategy Scorecard</h4>
                      <ul className="text-[11px] text-slate-300 space-y-2 list-disc pl-4 marker:text-slate-600">
                        <li>At entry, the voting strategies + regime are stored on the position.</li>
                        <li>At close, each is credited (right) or discredited (wrong), weighted by its confidence.</li>
                        <li>Older trades exponentially decay, so recent performance dominates (forgetting).</li>
                        <li>Hit-rate maps to a weight in <strong className="text-white">[0.3 - 1.7]x</strong> that biases future votes.</li>
                        <li>Tracked per strategy × regime, persisted, and charted in the Learning tab.</li>
                      </ul>
                    </div>
                    <div className="bg-slate-900/50 p-5 rounded-xl border border-slate-800">
                      <h4 className="text-amber-400 font-bold text-xs mb-3">Kelly Sizing Learner</h4>
                      <ul className="text-[11px] text-slate-300 space-y-2 list-disc pl-4 marker:text-slate-600">
                        <li>Reads the rolling window of your last ~100 closed trades.</li>
                        <li>Recomputes win-rate, average win and average loss (per-symbol when enough data).</li>
                        <li>Feeds the Kelly fraction that sizes each new BUY, capped for safety.</li>
                        <li>Always on — no toggle required.</li>
                      </ul>
                    </div>
                  </div>

                  <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-800 flex justify-center items-center gap-3 flex-wrap text-[10px] font-mono">
                    <span className="text-slate-300 bg-slate-800 px-2 py-1 rounded">Trade closes</span>
                    <span className="text-slate-500">→</span>
                    <span className="text-slate-300 bg-slate-800 px-2 py-1 rounded">Credit strategies</span>
                    <span className="text-slate-500">→</span>
                    <span className="text-slate-300 bg-slate-800 px-2 py-1 rounded">Decay + re-weight</span>
                    <span className="text-slate-500">→</span>
                    <span className="text-slate-300 bg-slate-800 px-2 py-1 rounded">Persist snapshot</span>
                    <span className="text-slate-500">→</span>
                    <span className="text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 rounded">Bias next vote</span>
                  </div>
                </div>

                {/* 8 - RISK & SAFETY CONTROLS */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-4 flex items-center gap-2">
                    <ShieldAlert size={18} className="text-rose-400" />
                    8 - RISK & SAFETY CONTROLS
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                      <h4 className="text-emerald-400 font-bold text-xs mb-2 flex items-center gap-2"><CheckCircle size={14}/> Paper-first default</h4>
                      <p className="text-[11px] text-slate-400">Runs in PAPER-MODE unless explicitly switched. The header badge always shows the current mode.</p>
                    </div>
                    <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                      <h4 className="text-emerald-400 font-bold text-xs mb-2 flex items-center gap-2"><CheckCircle size={14}/> Live double-lock</h4>
                      <p className="text-[11px] text-slate-400">Real-money orders need paperTradingOnly=false AND ALLOW_LIVE_TRADING=true.</p>
                    </div>
                    <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                      <h4 className="text-emerald-400 font-bold text-xs mb-2 flex items-center gap-2"><CheckCircle size={14}/> Circuit breakers</h4>
                      <p className="text-[11px] text-slate-400">Max daily loss and max total drawdown halt all new entries.</p>
                    </div>
                    <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                      <h4 className="text-emerald-400 font-bold text-xs mb-2 flex items-center gap-2"><CheckCircle size={14}/> Stop-loss / take-profit</h4>
                      <p className="text-[11px] text-slate-400">Per-position exits, plus an optional trailing stop that locks in gains.</p>
                    </div>
                    <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                      <h4 className="text-emerald-400 font-bold text-xs mb-2 flex items-center gap-2"><CheckCircle size={14}/> Correlation guard</h4>
                      <p className="text-[11px] text-slate-400">Blocks new BUYs when sector concentration exceeds the configured cap.</p>
                    </div>
                    <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                      <h4 className="text-emerald-400 font-bold text-xs mb-2 flex items-center gap-2"><CheckCircle size={14}/> Emergency stop</h4>
                      <p className="text-[11px] text-slate-400">The Command Center kill-switch halts scanning, decisions and execution instantly.</p>
                    </div>
                  </div>
                </div>

                {/* 9 - HOW TO USE IT */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-1 flex items-center gap-2">
                    <PlayCircle size={18} className="text-emerald-400" />
                    9 - HOW TO USE IT
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">From zero to a running paper-trading session.</p>
                  
                  <div className="space-y-2">
                    {[
                      {num: 1, title: 'Configure environment', text: 'Copy .env.example to .env and add keys: ALPACA_API_KEY / ALPACA_API_SECRET for US data & paper trades. Optionally QUESTRADE_REFRESH_TOKEN + QUESTRADE_ACCOUNT_ID for Canadian symbols, and an LLM key (GEMINI_API_KEY, etc.) for narrative analysis.'},
                      {num: 2, title: 'Start the platform', text: 'Run the dev server (tsx server.ts). It serves both the API and this dashboard on port 3000. Confirm the header badge reads PAPER-MODE.'},
                      {num: 3, title: 'Build your watchlist', text: 'Open the STRATEGY SCANNER tab → add or remove symbols. US tickers (AAPL) route to Alpaca; Canadian tickers (SHOP.TO) route to Questrade.'},
                      {num: 4, title: 'Tune scanner settings', text: 'Set scan interval, max open positions, minimum confidence, strategies required and Kelly cap. Enable bracket orders for automatic broker-side TP/SL.'},
                      {num: 5, title: 'Enable the scanner', text: 'Toggle the scanner on. It will scan on each interval, log signals, and auto-execute trades that clear the entry gate.'},
                      {num: 6, title: 'Monitor live', text: 'TRADING ARENA shows activity; HOLDINGS & POSITIONS shows open trades and P&L; ACTIVITY LOG streams every action.'},
                      {num: 7, title: 'Watch it learn', text: 'LEARNING & EVOLUTION shows the per-strategy scorecard and the Weight Evolution chart as trades close.'},
                      {num: 8, title: 'Backtest before going live', text: 'Use the backtest endpoint/panel to validate a symbol over historical bars. Review win-rate, Sharpe and max drawdown first.'},
                      {num: 9, title: 'Go live deliberately', text: 'Only after thorough paper validation: set paperTradingOnly=false and ALLOW_LIVE_TRADING=true. The badge turns to ⚡ LIVE-MODE. Start small.'}
                    ].map(step => (
                      <div key={step.num} className="bg-slate-900/50 p-3 rounded-lg border border-slate-800 flex gap-4 items-start">
                        <div className="w-5 h-5 rounded-full border border-emerald-500/50 text-emerald-400 flex items-center justify-center shrink-0 font-mono text-[10px] bg-emerald-500/10 mt-0.5">{step.num}</div>
                        <div>
                          <h4 className="text-white font-bold text-xs mb-1">{step.title}</h4>
                          <p className="text-[11px] text-slate-400 leading-relaxed max-w-4xl">{step.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 10 - HOW TO TRADE — WORKED EXAMPLE */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-1 flex items-center gap-2">
                    <TrendingUp size={18} className="text-emerald-400" />
                    10 - HOW TO TRADE — WORKED EXAMPLE
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">Follow one symbol from idea to closed trade. This is exactly what the scanner automates each cycle.</p>
                  
                  <div className="space-y-1">
                    {[
                      {num: 1, title: 'You add AAPL to the watchlist', text: "Scanner tab → type AAPL → Add. It's a US symbol, so it will route to Alpaca paper."},
                      {num: 2, title: 'Scanner pulls real data', text: "On the next cycle it fetches ~220 daily bars + the live mid-price for AAPL and seeds the indicator history."},
                      {num: 3, title: 'The 8 strategies vote', text: "e.g. RSI_14=BUY(0.71), TREND_200D=BUY(0.66), MEAN_REVERSION_Z=HOLD, BOLLINGER_BANDS=BUY(0.58)..."},
                      {num: 4, title: 'Regime is classified', text: "Say volatility is normal → the learned weights for the 'normal' regime are applied to each vote."},
                      {num: 5, title: 'Composite vote forms', text: "Weighted BUY mass > weighted SELL mass and enough strategies agree → candidate BUY at blended confidence 0.68."},
                      {num: 6, title: 'Entry gate checks', text: "Market open? ✓ Confidence ≥ min? ✓ Under max positions? ✓ Sector correlation under cap? ✓ No circuit breaker tripped? ✓"},
                      {num: 7, title: 'Kelly sizes the trade', text: "Using your recent win-rate / avg-win / avg-loss it allocates, say, 4.2% of equity (capped by your Kelly limit)."}
                    ].map((step, idx) => (
                      <React.Fragment key={step.num}>
                        <div className={"bg-slate-900/50 p-3 rounded-lg border flex gap-4 items-center " + (idx > 1 && idx < 5 ? 'border-indigo-500/20' : idx === 5 ? 'border-emerald-500/20' : idx === 6 ? 'border-amber-500/20' : 'border-slate-800')}>
                          <div className={"w-5 h-5 rounded-full border text-center flex items-center justify-center shrink-0 font-mono text-[10px] " + (idx > 1 && idx < 5 ? 'border-indigo-500/50 text-indigo-400 bg-indigo-500/10' : idx === 5 ? 'border-emerald-500/50 text-emerald-400 bg-emerald-500/10' : idx === 6 ? 'border-amber-500/50 text-amber-400 bg-amber-500/10' : 'border-emerald-500/50 text-emerald-400 bg-emerald-500/10')}>{step.num}</div>
                          <div className="flex items-center gap-3 w-full">
                            <h4 className={"font-bold text-xs whitespace-nowrap min-w-[200px] " + (idx > 1 && idx < 5 ? 'text-indigo-400' : idx === 5 ? 'text-emerald-400' : idx === 6 ? 'text-amber-400' : 'text-emerald-400')}>{step.title}</h4>
                            <p className="text-[11px] text-slate-300 font-mono hidden md:block">{step.text}</p>
                          </div>
                        </div>
                        {idx !== 6 && <div className="text-center text-slate-600 text-[10px] py-1">↓</div>}
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                {/* 11 - TAB-BY-TAB FEATURE REFERENCE */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-1 flex items-center gap-2">
                    <Layers size={18} className="text-indigo-400" />
                    11 - TAB-BY-TAB FEATURE REFERENCE
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">Every tab in the top navigation, and what you do there.</p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[
                      { icon: <Layers size={14} className="text-emerald-400"/>, title: 'Trading Arena', text: 'Live command view — current activity, headline metrics and what the engine is doing right now.' },
                      { icon: <Wallet size={14} className="text-emerald-400"/>, title: 'Holdings & Positions', text: 'Open positions with entry, current price, market value and unrealized P&L; realized P&L summary.' },
                      { icon: <Activity size={14} className="text-emerald-400"/>, title: 'Strategy Scanner', text: 'The heart of the system: manage the watchlist, tune scan interval / max positions / min confidence / Kelly cap, toggle bracket orders, enable or disable autonomous scanning, and view the latest per-symbol signals.' },
                      { icon: <BarChart3 size={14} className="text-emerald-400"/>, title: 'Agent Network', text: 'Live status and metrics for the agents — see who is active and how each is contributing.' },
                      { icon: <Clock size={14} className="text-emerald-400"/>, title: 'VEC Event Memory', text: 'The historical-precedent memory — past events the system compares the present against.' },
                      { icon: <Shield size={14} className="text-emerald-400"/>, title: 'Audit Logs', text: 'Immutable record of every risk decision, gate check and circuit-breaker event for compliance review.' },
                      { icon: <Target size={14} className="text-emerald-400"/>, title: 'Opportunity Feed', text: 'Ranked candidate trades the scanner has surfaced but not necessarily executed — your manual idea queue.' },
                      { icon: <BrainCircuit size={14} className="text-emerald-400"/>, title: 'Learning & Evolution', text: 'Per-strategy scorecard (hit-rate → weight) and the Weight Evolution chart showing how weights drift as trades close.' },
                      { icon: <Terminal size={14} className="text-emerald-400"/>, title: 'Command Center', text: 'System controls — emergency stop / resume, module toggles, and global settings including paper vs live mode.' },
                      { icon: <Activity size={14} className="text-emerald-400"/>, title: 'Activity Log', text: 'Chronological stream of every action the platform takes — scans, signals, orders, exits.' },
                      { icon: <Layers size={14} className="text-emerald-400"/>, title: 'Documentation', text: 'This page — architecture, agents, strategies, how to use and how to trade.' }
                    ].map((tab, i) => (
                      <div key={i} className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                        <h4 className="text-emerald-400 font-bold text-xs mb-1 flex items-center gap-2">{tab.icon} {tab.title}</h4>
                        <p className="text-[11px] text-slate-400">{tab.text}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 12 - KEY API ENDPOINTS */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-1 flex items-center gap-2">
                    <Terminal size={18} className="text-slate-400" />
                    12 - KEY API ENDPOINTS
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">The dashboard is just a client of these REST endpoints — call them directly for automation.</p>
                  
                  <div className="bg-slate-900/50 rounded-xl border border-slate-800 overflow-hidden">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-800/50 border-b border-slate-800">
                          <th className="px-4 py-3 text-[10px] font-mono text-slate-400 uppercase">Method</th>
                          <th className="px-4 py-3 text-[10px] font-mono text-slate-400 uppercase">Endpoint</th>
                          <th className="px-4 py-3 text-[10px] font-mono text-slate-400 uppercase">Purpose</th>
                        </tr>
                      </thead>
                      <tbody className="text-[11px] font-mono">
                        {[
                          { m: 'GET', p: '/api/v1/health', r: 'Liveness probe' },
                          { m: 'GET', p: '/api/v1/portfolio', r: 'Cash, positions & P&L' },
                          { m: 'GET', p: '/api/v1/scanner/status', r: 'Scanner state & cycle stats' },
                          { m: 'GET', p: '/api/v1/scanner/signals', r: 'Latest per-symbol signals' },
                          { m: 'GET', p: '/api/v1/agents/live', r: 'Real per-agent signals & roster (multi-agent)' },
                          { m: 'GET', p: '/api/v1/intelligence', r: 'Macro (FRED) + news (Finnhub) + data-source health' },
                          { m: 'POST', p: '/api/v1/intelligence/refresh', r: 'Force-refresh the macro snapshot' },
                          { m: 'GET', p: '/api/v1/logs', r: 'Search the durable NDJSON log archive (days)' },
                          { m: 'GET', p: '/api/v1/decisions', r: 'Actionable decision history (filterable)' },
                          { m: 'GET', p: '/api/v1/decisions/:id', r: 'Full decision replay (agent ballot + context)' },
                          { m: 'GET', p: '/api/v1/control', r: 'Control-tower mode + module toggles' },
                          { m: 'POST', p: '/api/v1/control/mode', r: 'Set trading mode (FULL_AUTO...EMERGENCY)' },
                          { m: 'PATCH', p: '/api/v1/control/modules', r: 'Enable/disable scanner, intel, execution...' },
                          { m: 'GET', p: '/metrics', r: 'Prometheus text exposition (observability)' },
                          { m: 'POST', p: '/api/v1/scanner/run', r: 'Trigger a scan cycle now' },
                          { m: 'GET', p: '/api/v1/scanner/scorecard', r: 'Learned per-strategy weights' },
                          { m: 'GET', p: '/api/v1/scanner/weight-history', r: 'Weight evolution time-series' },
                          { m: 'GET', p: '/api/v1/pnl/analytics', r: 'Realized P&L analytics' },
                          { m: 'POST', p: '/api/v1/backtest', r: 'Backtest a symbol on historical bars' },
                          { m: 'GET', p: '/api/v1/monitor/status', r: 'Position monitor state' },
                          { m: 'POST', p: '/api/v1/system/emergency-stop', r: 'Halt all engines' },
                          { m: 'POST', p: '/api/v1/system/resume', r: 'Resume after emergency stop' }
                        ].map((row, i) => (
                          <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                            <td className="px-4 py-2">
                              {row.m === 'GET' && <span className="text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded font-bold">{row.m}</span>}
                              {row.m === 'POST' && <span className="text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded font-bold">{row.m}</span>}
                              {row.m === 'PATCH' && <span className="text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 rounded font-bold">{row.m}</span>}
                            </td>
                            <td className="px-4 py-2 text-emerald-400 font-bold">{row.p}</td>
                            <td className="px-4 py-2 text-slate-300 font-sans">{row.r}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-800 bg-amber-500/5 overflow-hidden border border-amber-500/20 rounded-xl relative">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-500" />
                  <div className="p-4 pl-6">
                    <h4 className="text-amber-400 font-bold text-xs mb-1 flex items-center gap-2"><AlertTriangle size={14} /> Risk Disclaimer</h4>
                    <p className="text-[11px] text-slate-300 leading-relaxed font-mono">
                      ARGUS is software for research and education. Algorithmic trading carries substantial risk of loss, and past or backtested performance does not guarantee future results. Always validate thoroughly in PAPER-MODE before risking real capital, and never trade money you cannot afford to lose. You are solely responsible for any live orders the system places.
                    </p>
                  </div>
                </div>

             </div>
          </div>
        )}`;

if (!docTabRegex.test(content)) {
  console.log("Could not find documentation tab marker");
  process.exit(1);
}

const newContent = content.replace(docTabRegex, newDocContent);
fs.writeFileSync('src/App.tsx', newContent);
console.log("Documentation tab replaced successfully!");
