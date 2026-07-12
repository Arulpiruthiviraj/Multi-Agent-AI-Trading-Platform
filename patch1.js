const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Add agentRiskWeights state
const stateToAdd = `  const [agentRiskWeights, setAgentRiskWeights] = useState<Record<string, number>>({
    NewsAgent: 1.0,
    MacroAgent: 1.0,
    TechnicalAgent: 1.0,
    SentimentAgent: 1.0,
    OrderFlowAgent: 1.0,
  });
`;

code = code.replace(
  `const [enabledRiskAgents, setEnabledRiskAgents] = useState<Record<string, boolean>>({`,
  stateToAdd + `  const [enabledRiskAgents, setEnabledRiskAgents] = useState<Record<string, boolean>>({`
);

// 2. Add Risk Weight Sliders UI
const sliderUI = `                </div>
                {/* Backtest Risk Weights Tuner */}
                <div className="flex flex-col gap-2 bg-[#111822]/60 border border-slate-800/60 p-3 rounded-lg mb-4">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono text-slate-500 uppercase font-bold tracking-wider">
                      Backtest Engine: Agent Risk Weight Tuning
                    </span>
                    <button
                      onClick={() => setAgentRiskWeights({ NewsAgent: 1, MacroAgent: 1, TechnicalAgent: 1, SentimentAgent: 1, OrderFlowAgent: 1 })}
                      className="text-[9px] font-mono bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded transition-colors"
                    >
                      RESET WEIGHTS
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4 mt-2">
                    {[
                      { key: "NewsAgent", label: "News NLP", color: "text-blue-400" },
                      { key: "MacroAgent", label: "Macro Quant", color: "text-emerald-400" },
                      { key: "TechnicalAgent", label: "Technical TA", color: "text-purple-400" },
                      { key: "SentimentAgent", label: "Sentiment Social", color: "text-amber-400" },
                      { key: "OrderFlowAgent", label: "Order Flow L2", color: "text-rose-400" },
                    ].map((agent) => (
                      <div key={agent.key} className="flex flex-col gap-1.5">
                        <div className="flex justify-between items-center text-[9px] font-mono">
                          <span className={agent.color}>{agent.label}</span>
                          <span className="text-slate-300">{(agentRiskWeights[agent.key] || 1).toFixed(1)}x</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="3"
                          step="0.1"
                          value={agentRiskWeights[agent.key] || 1}
                          onChange={(e) => setAgentRiskWeights(prev => ({ ...prev, [agent.key]: parseFloat(e.target.value) }))}
                          className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                      </div>
                    ))}
                  </div>
                </div>`;

code = code.replace(
  `                </div>\n                {/* Recharts Stacked Area Chart */}`,
  sliderUI + `\n                {/* Recharts Stacked Area Chart */}`
);

fs.writeFileSync('src/App.tsx', code);
console.log("Patched UI");
