const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

const docTabRegex = /\{activeTab === "documentation" && \([\s\S]*?\n        \)\}/;

const newDocContent = `{activeTab === "documentation" && (
          <div className="animate-fade-in flex flex-col gap-6" id="doc-view">
             <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
                
                {/* 1 - SYSTEM ARCHITECTURE */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-2 flex items-center gap-2">
                    <Server size={18} className="text-emerald-400" />
                    1 - SYSTEM ARCHITECTURE
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">Four layers. The TypeScript server is the brain; the browser is the cockpit; brokers & data are the outside world; a JSON snapshot is the memory.</p>
                  
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800 mb-2">
                    <h4 className="text-emerald-400 font-bold text-xs mb-1 uppercase tracking-wider text-[10px]">PRESENTATION LAYER</h4>
                    <p className="text-white text-sm font-bold mb-1">React + Vite + Tailwind dashboard (this UI)</p>
                    <p className="text-xs text-slate-400">Tabs poll the server's REST API every few seconds and render portfolio, scanner signals, agents, learning charts and this documentation.</p>
                  </div>
                  
                  <div className="text-center text-slate-600 text-[10px] py-1">↓</div>
                  
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-indigo-500/30 mb-2 bg-indigo-500/5">
                    <h4 className="text-indigo-400 font-bold text-xs mb-1 uppercase tracking-wider text-[10px]">APPLICATION / LOGIC LAYER</h4>
                    <p className="text-white text-sm font-bold mb-1">Node.js + Express + TypeScript server (server.ts)</p>
                    <p className="text-xs text-slate-400">Hosts the Rule Engine, auto-scanner, strategy panel, regime classifier, risk gates, Kelly sizer, position monitor, brokers and the online learner. Serves both the API and the built UI.</p>
                  </div>

                  <div className="text-center text-slate-600 text-[10px] py-1">↓</div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                     <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                        <h4 className="text-sky-400 font-bold text-xs mb-1 uppercase tracking-wider text-[10px]">EXTERNAL INTEGRATIONS</h4>
                        <p className="text-white text-sm font-bold mb-1">Alpaca - Questrade - LLM providers</p>
                        <p className="text-xs text-slate-400">Alpaca = US market data + paper/live orders. Questrade = Canadian (TSX/TSXV) orders. Gemini/OpenAI/Claude/Mistral = optional narrative analysis.</p>
                     </div>
                     <div className="bg-slate-900/50 p-4 rounded-xl border border-amber-500/30 bg-amber-500/5">
                        <h4 className="text-amber-400 font-bold text-xs mb-1 uppercase tracking-wider text-[10px]">PERSISTENCE LAYER</h4>
                        <p className="text-white text-sm font-bold mb-1">JSON snapshot + rules config</p>
                        <p className="text-xs text-slate-400">data/snapshot.json stores runtime state (positions, P&L, learned weights). config/app.rules.json declares all rules & parameters.</p>
                     </div>
                  </div>
                  
                  <p className="text-[11px] text-slate-500 mt-4">Note: the <code className="text-slate-400">python-platform/</code> folder is an experimental multi-agent prototype and is not wired into the live trading loop.</p>
                </div>

                {/* 2 - THE CORE LOOP */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-2 flex items-center gap-2">
                    <RefreshCw size={18} className="text-emerald-400" />
                    2 - THE CORE LOOP
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">Every scan cycle (default: 5 min) runs the same four-stage loop. The fourth stage feeds back into the first.</p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="bg-slate-900/50 p-5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 relative">
                      <Cpu size={16} className="text-emerald-400 mb-3" />
                      <h4 className="text-white font-bold text-xs mb-2">1. SCAN</h4>
                      <p className="text-[11px] text-slate-400">Pull real bars + live mid-quotes for the whole watchlist (batched).</p>
                    </div>
                    
                    <div className="hidden md:flex items-center justify-center -mx-4 z-10 text-slate-600">→</div>
                    
                    <div className="bg-slate-900/50 p-5 rounded-xl border border-indigo-500/30 bg-indigo-500/5 relative">
                      <Layers size={16} className="text-indigo-400 mb-3" />
                      <h4 className="text-white font-bold text-xs mb-2">2. DECIDE</h4>
                      <p className="text-[11px] text-slate-400">Run all agents → classify regime → risk agents veto → consensus agent issues BUY/SELL/HOLD.</p>
                    </div>
                    
                    <div className="hidden md:flex items-center justify-center -mx-4 z-10 text-slate-600">→</div>
                    
                    <div className="bg-slate-900/50 p-5 rounded-xl border border-sky-500/30 bg-sky-500/5 relative">
                      <Zap size={16} className="text-sky-400 mb-3" />
                      <h4 className="text-white font-bold text-xs mb-2">3. EXECUTE</h4>
                      <p className="text-[11px] text-slate-400">Pass risk gates → Kelly-size → route order to Alpaca / Questrade.</p>
                    </div>
                    
                    <div className="hidden md:flex items-center justify-center -mx-4 z-10 text-slate-600">→</div>
                    
                    <div className="bg-slate-900/50 p-5 rounded-xl border border-amber-500/30 bg-amber-500/5 relative">
                      <Target size={16} className="text-amber-400 mb-3" />
                      <h4 className="text-white font-bold text-xs mb-2">4. LEARN</h4>
                      <p className="text-[11px] text-slate-400">On every close, credit/discredit each voting strategy & re-weight.</p>
                    </div>
                  </div>
                  
                  <div className="text-[10px] text-slate-500 font-mono text-center mt-3 mt-4 flex items-center justify-center gap-2">
                    <RefreshCw size={10} /> LEARN feeds back into DECIDE on the next cycle
                  </div>
                </div>

                {/* 3 - HOW A TRADE IS BORN */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-2 flex items-center gap-2">
                    <Layers size={18} className="text-indigo-400" />
                    3 - HOW A TRADE IS BORN
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">The full decision pipeline for a single symbol, top to bottom.</p>
                  
                  <div className="space-y-1 relative">
                    {[
                      {num: 1, title: 'Market data', text: "Real daily bars seed the indicator history; the latest mid-price ((bid+ask)/2) is the decision price. Falls back to a simulated walk only if no data/keys.", sub: "fetchAlpacaBars · fetchAlpacaMidQuotes"},
                      {num: 2, title: 'Strategy panel', text: "8 technical strategies (RSI, MACD, Bollinger, momentum, mean-reversion, etc.) each emit BUY / SELL / HOLD + a confidence score.", sub: "runAllStrategies()"},
                      {num: 3, title: 'Regime classifier', text: "Recent volatility buckets the market into low_vol / normal / high_vol. Strategy weights are learned separately per regime.", sub: "regimeFor()"},
                      {num: 4, title: 'Agent consensus', text: "Each agent's vote is weighted by its learned weight × confidence × regime multiplier. BUY needs enough agreeing technical agents AND buy-score > sell-score AND no risk-agent veto.", sub: "runAgentOrchestrator()"},
                      {num: 5, title: 'Entry gate', text: "Declarative rules block the trade if the market is closed, confidence is too low, the position cap is hit, or sector correlation is too high.", sub: "RuleEngine.checkEntryGate()"},
                      {num: 6, title: 'Circuit breakers', text: "Hard stops: max daily loss and max drawdown halt all new entries.", sub: "RuleEngine.checkCircuitBreakers()"},
                      {num: 7, title: 'Position sizing', text: "Kelly criterion sizes the trade from your recent win-rate / avg-win / avg-loss, capped at a max fraction of the portfolio.", sub: "deriveKellyInputs() · kellySize()"},
                      {num: 8, title: 'Broker routing', text: "US symbol → Alpaca (paper by default). Canadian (.TO/.V/.TSX) → Questrade (real money, hard-gated). Bracket TP/SL attached when enabled.", sub: "placeAlpacaOrder · placeQuestradeOrder"},
                      {num: 9, title: 'Position monitor', text: "Every ~30s re-prices open positions and applies stop-loss / take-profit / trailing-stop exits — unless a broker bracket already manages them.", sub: "runPositionMonitor()"},
                      {num: 10, title: 'Close & learn', text: "On exit, realized P&L is recorded and every strategy that voted at entry is credited or discredited, updating its weight.", sub: "updateStrategyScorecard()"}
                    ].map((step, idx) => (
                      <React.Fragment key={step.num}>
                        <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-800 flex gap-4 items-start">
                          <div className="w-5 h-5 rounded-full border border-slate-600 text-slate-300 flex items-center justify-center shrink-0 font-mono text-[10px] bg-slate-800 mt-0.5">{step.num}</div>
                          <div className="w-full">
                            <h4 className="text-white font-bold text-[13px] mb-1">{step.title}</h4>
                            <p className="text-[11px] text-slate-300 leading-relaxed max-w-4xl">{step.text}</p>
                            <p className="text-[10px] font-mono text-emerald-500 mt-2">{step.sub}</p>
                          </div>
                        </div>
                        {idx !== 9 && <div className="text-center text-slate-600 text-[10px] py-1">↓</div>}
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                {/* 4 - THE AGENT ROSTER */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-2 flex items-center gap-2">
                    <Network size={18} className="text-emerald-400" />
                    4 - THE AGENT ROSTER
                  </h2>
                  <p className="text-[11px] text-slate-300 mb-2">ARGUS is organised as a society of specialised agents. Each agent is a narrow expert that emits a signal; higher layers aggregate those signals into one decision. Agents are grouped into four cooperating tiers.</p>
                  
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800 mb-6 space-y-3">
                     <p className="text-[11px] text-slate-300">
                       <strong className="text-emerald-400">What runs live today:</strong> a genuine native-Typescript multi-agent system inside server.ts drives every scan and order. On each cycle the orchestrator runs 8 Technical agents (one per strategy, learned-weighted by regime) + a Quant Drift agent, a Market Regime agent that scales conviction, and three Risk agents (Exposure, Correlation, Circuit Breaker) that hold <strong className="text-white">veto power</strong>. A Consensus agent aggregates the survivors into the final BUY / SELL / HOLD. Live per-agent signals are served at /api/v1/agents/live.
                     </p>
                     <p className="text-[11px] text-slate-300">
                       <strong className="text-indigo-400">The deeper design:</strong> the Intelligence, Quantitative and Decision agents below describe the fuller LLM-backed brain prototyped in python-platform/. They are not yet wired into the live loop - the native TS agents above are what actually trade.
                     </p>
                  </div>
                  
                  {/* TIER 1 */}
                  <div className="mb-6">
                     <div className="flex items-center gap-3 mb-3">
                       <span className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wider">TIER 1 · INTELLIGENCE AGENTS</span>
                       <span className="text-[11px] text-slate-400">read the world → conviction</span>
                     </div>
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {[
                          {name: "EventMemoryAgent", title: "Historical Precedent Memory", desc: "Looks up past market crises and macro precedents to judge whether today resembles a known regime. Emits BUY/SELL/HOLD at confidence 0.55-0.72.", inOut: "in: macro headline · out: precedent-matched signal", en: true},
                          {name: "NarrativeTrackingAgent", title: "Thematic Narrative Tracker", desc: "Scores the strength of investment themes — AI (strengthening), Defense Spending (strengthening), Manufacturing Reshoring (emerging), Rate Cuts (weakening) — and maps them to sectors.", inOut: "in: sector · out: BUY on strengthening narrative", en: true},
                          {name: "PoliticalIntelligenceAgent", title: "Political Risk Analyst", desc: "Assesses tariffs, regulatory scrutiny and infrastructure legislation. SELL on tariff threats, HOLD under antitrust, BUY under constructive legislation.", inOut: "in: tariffs, oversight level · out: conf 0.58-0.78", en: true},
                          {name: "GeopoliticalIntelligenceAgent", title: "Geopolitical Monitor", desc: "Tracks trade disputes, conflicts and blockades via a 0-1 risk index. SELL when conflict > 0.7, BUY in calm conditions.", inOut: "in: geopolitical risk index · out: conf 0.55-0.80", en: true},
                          {name: "NewsSentimentAgent", title: "Per-Symbol News Sentiment", desc: "Aggregates headline sentiment for a specific ticker into directional conviction.", inOut: "in: news headlines · out: sentiment-weighted signal", en: true},
                          {name: "MacroIntelligenceAgent", title: "Macro Regime Reader", desc: "Interprets CPI, the Fed rate and the yield-curve slope to set a risk-on or risk-off posture.", inOut: "in: CPI, Fed rate, curve · out: macro bias", en: true}
                        ].map((a, i) => (
                           <div key={i} className="bg-slate-900/50 p-3 rounded-lg border border-slate-800">
                             <div className="flex justify-between items-start mb-1">
                               <h4 className="text-sky-400 font-bold text-[13px]">{a.name}</h4>
                               <span className="text-[9px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded font-mono">ENABLED</span>
                             </div>
                             <p className="text-white text-xs font-bold mb-1.5">{a.title}</p>
                             <p className="text-[11px] text-slate-400 mb-2 leading-relaxed">{a.desc}</p>
                             <p className="text-[10px] text-slate-500 font-mono">{a.inOut}</p>
                           </div>
                        ))}
                     </div>
                  </div>

                  {/* TIER 2 */}
                  <div className="mb-6">
                     <div className="flex items-center gap-3 mb-3">
                       <span className="bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wider">TIER 2 · QUANTITATIVE AGENTS</span>
                       <span className="text-[11px] text-slate-400">model the price → probability</span>
                     </div>
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {[
                          {name: "BaselineModelAgent", title: "Linear Trend Baseline", desc: "Fits a linear regression on log-returns to detect slope. Simple, interpretable trend anchor. BUY if slope > 0.0005, SELL if < -0.0005.", inOut: "in: prices, volumes (≥20 bars)", en: true},
                          {name: "MLAgent", title: "Gradient-Boosted Classifier", desc: "XGBoost/LightGBM model engineering SMA ratio, RSI, Bollinger %B and volume Z-score features to predict trend continuation vs exhaustion. Confidence up to 0.90.", inOut: "in: prices, volumes (120 bars)", en: true},
                          {name: "DeepLearningAgent", title: "LSTM + Transformer (placeholder)", desc: "Sequence-to-signal deep model (dim 128, 4 heads) over 60-bar windows. Not yet trained — always HOLD until weights are loaded.", inOut: "in: prices · out: HOLD", en: false},
                          {name: "MarketRegimeAgent", title: "Regime Classifier", desc: "Classifies the benchmark into BULL / BEAR / SIDEWAYS / HIGH_VOLATILITY / LOW_VOLATILITY and returns multipliers that scale every other agent's voting weight.", inOut: "in: benchmark prices · out: regime + multipliers", en: true}
                        ].map((a, i) => (
                           <div key={i} className={"bg-slate-900/50 p-3 rounded-lg border border-slate-800 " + (!a.en ? "opacity-60" : "")}>
                             <div className="flex justify-between items-start mb-1">
                               <h4 className={(a.en ? "text-sky-400" : "text-slate-400") + " font-bold text-[13px]"}>{a.name}</h4>
                               <span className={"text-[9px] px-1.5 py-0.5 rounded font-mono " + (a.en ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-800 text-slate-400")}>{a.en ? 'ENABLED' : 'DISABLED'}</span>
                             </div>
                             <p className="text-white text-xs font-bold mb-1.5">{a.title}</p>
                             <p className="text-[11px] text-slate-400 mb-2 leading-relaxed">{a.desc}</p>
                             <p className="text-[10px] text-slate-500 font-mono">{a.inOut}</p>
                           </div>
                        ))}
                     </div>
                  </div>

                  {/* TIER 3 */}
                  <div className="mb-6">
                     <div className="flex items-center gap-3 mb-3">
                       <span className="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wider">TIER 3 · DECISION AGENTS</span>
                       <span className="text-[11px] text-slate-400">debate the signals → one verdict</span>
                     </div>
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {[
                          {name: "BuyAgent", title: "Entry Strategist", desc: "Aggregates all BUY signals. Fires when ≥2 agents agree at avg confidence > 0.60, OR a single agent reaches ≥ 0.75.", inOut: "out: (triggered, confidence, reason)", en: true},
                          {name: "SellAgent", title: "Exit Strategist", desc: "Aggregates SELL signals with a deliberately lower bar (1 signal at ≥ 0.55) — capital protection is prioritised over conviction.", inOut: "out: (triggered, confidence, reason)", en: true},
                          {name: "SellValidationAgent", title: "Exit Sanity Check", desc: "Second pass before a sell executes. Distinguishes a structural breakdown from a temporary dip — vetoes the sell (HOLD) if the 5-bar drop is small and the sector is strongly bullish.", inOut: "out: (valid, explanation)", en: true},
                          {name: "ThesisAgent", title: "Thesis Keeper", desc: "Records the narrative reason for every entry and re-checks it before exits. Blocks exit if the thesis still holds; forces exit if the thesis is broken.", inOut: "out: (thesisValid, explanation)", en: true},
                          {name: "ConsensusAgent", title: "Chief Orchestrator", desc: "Top-level node. Collects Buy / Sell / SellValidation / Thesis outputs and compiles the final weighted BUY / SELL / HOLD instruction sent to the broker.", inOut: "out: final trade instruction + reasoning", en: true}
                        ].map((a, i) => (
                           <div key={i} className="bg-slate-900/50 p-3 rounded-lg border border-slate-800">
                             <div className="flex justify-between items-start mb-1">
                               <h4 className="text-amber-400 font-bold text-[13px]">{a.name}</h4>
                               <span className="text-[9px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded font-mono">ENABLED</span>
                             </div>
                             <p className="text-white text-xs font-bold mb-1.5">{a.title}</p>
                             <p className="text-[11px] text-slate-400 mb-2 leading-relaxed">{a.desc}</p>
                             <p className="text-[10px] text-slate-500 font-mono">{a.inOut}</p>
                           </div>
                        ))}
                     </div>
                  </div>

                  {/* TIER 4 */}
                  <div className="mb-6">
                     <div className="flex items-center gap-3 mb-3">
                       <span className="bg-rose-500/10 text-rose-400 border border-rose-500/30 text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wider">TIER 4 · RISK AGENTS (VETO POWER)</span>
                       <span className="text-[11px] text-slate-400">protect the capital → can override any BUY</span>
                     </div>
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {[
                          {name: "PositionSizingAgent", title: "Allocator", desc: "Sizes each new trade via confidence curves or the Kelly Criterion. Hard cap of 10% of cash per position (default $100, max $5,000).", inOut: "in: confidence, cash · out: trade size $", en: true},
                          {name: "ExposureAgent", title: "Sector Concentration Guard", desc: "Vetoes any trade that would push a single sector above 35% of portfolio equity.", inOut: "out: (allowed, reason)", en: true},
                          {name: "CorrelationAgent", title: "Diversification Enforcer", desc: "Computes 30-day Pearson correlation against open positions. Hard veto at p ≥ 0.80; soft size-halving at p ≥ 0.65.", inOut: "out: (allowed, sizeMultiplier, reason)", en: true},
                          {name: "RuleEngine (TypeScript)", title: "Circuit Breakers — LIVE", desc: "Runs in server.ts after every realized trade. Halts ALL trading when the daily-loss ($1,000) or drawdown (15%) thresholds are breached.", inOut: "config: circuitBreakers[]", en: true}
                        ].map((a, i) => (
                           <div key={i} className="bg-slate-900/50 p-3 rounded-lg border border-rose-500/20">
                             <div className="flex justify-between items-start mb-1">
                               <h4 className="text-rose-400 font-bold text-[13px]">{a.name}</h4>
                               <span className="text-[9px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded font-mono">ENABLED</span>
                             </div>
                             <p className="text-white text-xs font-bold mb-1.5">{a.title}</p>
                             <p className="text-[11px] text-slate-400 mb-2 leading-relaxed">{a.desc}</p>
                             <p className="text-[10px] text-slate-500 font-mono">{a.inOut}</p>
                           </div>
                        ))}
                     </div>
                  </div>

                </div>

                {/* DEEP DIVE */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-2 flex items-center gap-2">
                    <Terminal size={18} className="text-indigo-400" />
                    DEEP DIVE - WHY THERE'S A PYTHON PLATFORM
                  </h2>
                  <p className="text-xs text-slate-300 mb-4">The python-platform/ folder is a standalone FastAPI microservice — the full reference implementation of the multi-agent brain. It is where every agent above genuinely executes.</p>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5">
                       <h4 className="text-emerald-400 font-bold text-[13px] mb-2 flex items-center gap-2"><Zap size={14} /> TypeScript Server — the live trader</h4>
                       <ul className="text-[11px] text-slate-300 space-y-2 list-disc pl-4 marker:text-emerald-500">
                         <li>Runs the real, always-on scan → decide → execute → learn loop.</li>
                         <li>Distils the agent design into 8 fast technical strategies + risk gates.</li>
                         <li>Talks to Alpaca / Questrade and serves this dashboard.</li>
                         <li>Optimised for low latency and continuous operation.</li>
                       </ul>
                    </div>
                    <div className="p-4 rounded-xl border border-indigo-500/30 bg-indigo-500/5">
                       <h4 className="text-indigo-400 font-bold text-[13px] mb-2 flex items-center gap-2"><Terminal size={14} /> Python Platform — the research brain</h4>
                       <ul className="text-[11px] text-slate-300 space-y-2 list-disc pl-4 marker:text-indigo-500">
                         <li>Instantiates all 19 agents via MultiAgentTradingEngine.</li>
                         <li>Runs the full pipeline: intel → quant → decision → risk veto → paper fill → P&L.</li>
                         <li>Has its own paper broker, portfolio manager, LLM service & event memory.</li>
                         <li>Optimised for richer reasoning, ML models and research — not low latency.</li>
                       </ul>
                    </div>
                  </div>

                  <h3 className="text-xs font-bold text-slate-300 mb-2">Why keep both?</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                    {[
                      { icon: <CheckCircle size={12}/>, title: "Reference architecture", desc: "Documents the complete intended brain — dependency injection, domain entities, agent lifecycle — that the lean TS core is modelled on." },
                      { icon: <CheckCircle size={12}/>, title: "Heavy ML belongs in Python", desc: "XGBoost / LightGBM and the planned LSTM+Transformer live where the data-science ecosystem is strongest." },
                      { icon: <CheckCircle size={12}/>, title: "Research & experimentation", desc: "Evaluate a symbol through the entire agent panel + LLM via /api/v1/signals without touching the live trader." },
                      { icon: <CheckCircle size={12}/>, title: "Separation of concerns", desc: "Slow, deep reasoning is isolated from the fast execution path, so research can't stall live trading." },
                      { icon: <CheckCircle size={12}/>, title: "Future integration path", desc: "The TS server can later call the Python engine as a service to enrich its votes — the wiring point already exists." },
                      { icon: <CheckCircle size={12}/>, title: "Independently deployable", desc: "Ships as its own container (docker-compose) and can scale separately from the trading server." }
                    ].map((r, i) => (
                      <div key={i} className="bg-slate-900/50 p-3 rounded-lg border border-slate-800">
                        <h4 className="text-sky-400 font-bold text-[11px] mb-1 flex items-center gap-1.5">{r.icon} {r.title}</h4>
                        <p className="text-[10px] text-slate-400 leading-relaxed">{r.desc}</p>
                      </div>
                    ))}
                  </div>

                  <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/5 mb-4">
                    <h4 className="text-amber-400 font-bold text-[12px] mb-1 flex items-center gap-1.5"><AlertTriangle size={14}/> Important:</h4>
                    <p className="text-[11px] text-slate-300">
                       the Python platform is a separate process and is NOT currently wired into the live TypeScript scanner — the two do not talk to each other yet. Your real paper/live trades are driven entirely by the TypeScript server. The Python service is optional: run it with docker-compose up (or uvicorn) only if you want to explore the full agent reasoning or develop the ML models.
                    </p>
                  </div>
                  
                  <div className="text-[10px] font-mono text-slate-500">
                    Entry point: <span className="text-slate-300">python-platform/api/main.py</span> · engine: <span className="text-slate-300">services/trading_engine.py</span> · agents: <span className="text-slate-300">agents/*.py</span>
                  </div>
                </div>

                {/* 5 - THE 8 EXECUTION STRATEGIES */}
                <div className="mb-8">
                  <h2 className="text-[14px] font-bold text-white mb-2 flex items-center gap-2">
                    <Cpu size={18} className="text-emerald-400" />
                    5 - THE 8 EXECUTION STRATEGIES
                  </h2>
                  <p className="text-[11px] text-slate-300 mb-4">These TypeScript strategies are what actually votes on every live scan. Each returns BUY / SELL / HOLD + a confidence, and its vote is scaled by the weight the learner has assigned it for the current regime.</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-4">
                     {[
                       { id: "MEAN_REVERSION_Z", type: "MEAN-REVERSION", name: "Z-Score Mean Reversion", desc: "Buys deeply oversold / sells deeply overbought on the 20-day Z-score of log-returns." },
                       { id: "BREAKOUT_52W", type: "MOMENTUM", name: "52-Week Breakout", desc: "Buys near the 52-week high (continuation); short-sells near the 52-week low." },
                       { id: "VOLUME_SURGE", type: "VOLUME", name: "Volume Surge", desc: "Trades with price direction when volume is 1.8× its 20-day average." },
                       { id: "RSI_14", type: "OSCILLATOR", name: "RSI (14)", desc: "Classic oscillator — buy oversold (< 32), sell overbought (> 68)." },
                       { id: "TREND_200D", type: "TREND", name: "200-Day Trend", desc: "Long above a positively-sloped 200-EMA; short below a negatively-sloped one." },
                       { id: "MOMENTUM_12_1", type: "FACTOR", name: "12-1 Momentum", desc: "Classic 12-month-minus-1-month momentum factor." },
                       { id: "VOLATILITY_REGIME", type: "REGIME", name: "Volatility Regime", desc: "Prefers entries in low-vol regimes; signals caution in high-vol regimes." },
                       { id: "BOLLINGER_BANDS", type: "MEAN-REVERSION", name: "Bollinger Bands", desc: "Mean reversion on 20-day Bollinger Bands (20): buy lower band, sell upper band." }
                     ].map((s, idx) => (
                       <div key={idx} className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                          <div className="flex justify-between items-center mb-2">
                             <h3 className="text-emerald-400 font-bold text-[12px] uppercase tracking-wide">{s.id}</h3>
                             <span className="text-[9px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono uppercase tracking-wider">{s.type}</span>
                          </div>
                          <p className="text-white text-sm font-bold mb-1">{s.name}</p>
                          <p className="text-xs text-slate-400">{s.desc}</p>
                       </div>
                     ))}
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
                    <div className="bg-slate-800 text-white text-xs font-bold px-4 py-2 rounded-lg mb-2 border border-slate-700">Order for symbol</div>
                    <div className="text-slate-500 mb-2 font-mono text-[10px]">↓</div>
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 w-full">
                       <div className="border border-emerald-500/30 rounded-lg p-4 bg-emerald-500/5">
                         <h4 className="text-emerald-400 font-bold text-xs mb-1">US symbols → Alpaca</h4>
                         <p className="text-[11px] text-slate-300">Defaults to the paper-api endpoint — safe to run live. Real-money orders require both paperTradingOnly=false and ALLOW_LIVE_TRADING=true.</p>
                       </div>
                       <div className="border border-rose-500/30 rounded-lg p-4 bg-rose-500/5">
                         <h4 className="text-rose-400 font-bold text-xs mb-1">CDN (.TO/.V) → Questrade</h4>
                         <p className="text-[11px] text-slate-300">Questrade has no paper environment — every order is real money, so it is hard-gated. In paper mode the trade stays simulated in the in-memory ledger.</p>
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
                          <h4 className="text-white font-bold text-[13px] mb-1">{step.title}</h4>
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
                            <h4 className={"font-bold text-[13px] whitespace-nowrap min-w-[200px] " + (idx > 1 && idx < 5 ? 'text-indigo-400' : idx === 5 ? 'text-emerald-400' : idx === 6 ? 'text-amber-400' : 'text-emerald-400')}>{step.title}</h4>
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
                      <div key={i} className="bg-slate-900/50 p-4 rounded-xl border border-slate-800 flex items-start gap-3">
                        <div className="mt-0.5">{tab.icon}</div>
                        <div>
                          <h4 className="text-emerald-400 font-bold text-[13px] mb-1">{tab.title}</h4>
                          <p className="text-[11px] text-slate-400">{tab.text}</p>
                        </div>
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

                <div className="pt-4 border-t border-slate-800 bg-amber-500/5 overflow-hidden border border-amber-500/20 rounded-xl relative mt-12 mb-4">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-500" />
                  <div className="p-4 pl-6">
                    <h4 className="text-amber-400 font-bold text-[13px] mb-1 flex items-center gap-2"><AlertTriangle size={14} /> Risk Disclaimer</h4>
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

content = content.replace(docTabRegex, newDocContent);
fs.writeFileSync('src/App.tsx', content);
console.log("Full documentation tab replaced successfully!");
