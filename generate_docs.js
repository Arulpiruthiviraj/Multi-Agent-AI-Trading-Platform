const fs = require('fs');

const content = `import React, { useState } from "react";
import { 
  BookOpen, Layers, Target, Activity, Wallet, BarChart3, 
  BrainCircuit, Terminal, Zap, ShieldCheck, Search, X, 
  ChevronRight, AlignLeft, Info, Settings, Database, 
  LineChart, Bot, CheckCircle2, Play, Circle, PlayCircle,
  Network, Scale, Cpu, Radar, MessageSquare, AlertTriangle
} from "lucide-react";

interface DocumentationTabProps {
  setActiveTab: (tab: string) => void;
}

type DocSection = {
  id: string;
  category: string;
  title: string;
  icon: JSX.Element;
  isCourse?: boolean;
  content: JSX.Element;
};

const DocumentationTab: React.FC<DocumentationTabProps> = ({ setActiveTab }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSectionId, setActiveSectionId] = useState<string>("intro-basics");
  const [completedModules, setCompletedModules] = useState<Record<string, boolean>>({});
  const [beginnerMode, setBeginnerMode] = useState<boolean>(true);

  const markCompleted = (id: string) => {
    setCompletedModules(prev => ({ ...prev, [id]: true }));
  };

  const sections: DocSection[] = [
    // COURSE 1: Getting Started
    {
      id: "intro-basics",
      category: "1. Beginner Onboarding",
      title: "Trading Basics",
      isCourse: true,
      icon: <BookOpen size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-white tracking-tight">Welcome to Trading Basics</h2>
            {beginnerMode && (
              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5">
                <CheckCircle2 size={12}/> Beginner Mode Active
              </span>
            )}
          </div>
          
          <p className="text-slate-300 leading-relaxed text-sm">
            Whether you've never bought a stock before or you're just new to automated systems, this guide will explain everything in plain English.
          </p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-indigo-500/30 transition-colors">
              <h3 className="text-indigo-400 font-bold mb-2 flex items-center gap-2"><LineChart size={16}/> What is Trading?</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Trading is simply buying an asset (like a piece of a company, called a <strong>Stock</strong>) at one price and hoping to sell it later at a higher price. The difference is your profit.
              </p>
            </div>
            
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-emerald-500/30 transition-colors">
              <h3 className="text-emerald-400 font-bold mb-2 flex items-center gap-2"><Target size={16}/> What is Automated Trading?</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Instead of a human sitting at a screen guessing what will happen, <strong>Automated Trading</strong> uses computers, math, and Artificial Intelligence to make decisions incredibly fast, without emotional panic.
              </p>
            </div>
            
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-amber-500/30 transition-colors">
              <h3 className="text-amber-400 font-bold mb-2 flex items-center gap-2"><ShieldCheck size={16}/> What is Risk?</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Risk is the possibility of losing money. Our system uses a strict <strong>Risk Engine</strong> to calculate exactly how much money is safe to trade, preventing large disasters.
              </p>
            </div>
            
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-rose-500/30 transition-colors">
              <h3 className="text-rose-400 font-bold mb-2 flex items-center gap-2"><Bot size={16}/> What are AI Trading Agents?</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Think of AI Agents as a team of specialized analysts. One AI reads the news, another looks at math, and another plays "Devil's Advocate." They debate before buying anything.
              </p>
            </div>
          </div>
          
          <div className="bg-slate-800/50 border border-slate-700 p-5 rounded-lg mt-8 flex justify-between items-center">
            <div>
              <h4 className="text-white font-bold mb-1">Beginner Trading Mode</h4>
              <p className="text-slate-400 text-xs">When enabled, the app explains complex terms with tooltips, limits your trade size, and requires manual confirmation before any automated execution.</p>
            </div>
            <button 
              onClick={() => setBeginnerMode(!beginnerMode)}
              className={"px-4 py-2 rounded text-xs font-bold transition-colors " + (beginnerMode ? "bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.3)]" : "bg-slate-700 text-slate-300")}
            >
              {beginnerMode ? "Enabled" : "Enable Mode"}
            </button>
          </div>

          <div className="flex justify-end mt-8">
            <button 
              onClick={() => { markCompleted("intro-basics"); setActiveSectionId("arch-flow"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors"
            >
              Complete Module & Continue <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },
    
    // COURSE 2: Architecture flow
    {
      id: "arch-flow",
      category: "1. Beginner Onboarding",
      title: "Trading Decision Flow",
      isCourse: true,
      icon: <Network size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight mb-2">How Does It Work?</h2>
          <p className="text-slate-400 text-sm mb-8">
            Before any trade is made, the system goes through a strict pipeline. Here is the visual architecture of how everything works together.
          </p>

          <div className="bg-[#111822] border border-slate-800 p-6 rounded-lg font-mono text-xs flex flex-col items-center">
             
             <div className="bg-slate-800/80 text-white px-4 py-2 rounded border border-slate-700 w-64 text-center font-bold">1. Market Data Collection</div>
             <div className="h-6 w-px bg-slate-700 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>
             
             <div className="bg-indigo-500/10 text-indigo-400 px-4 py-2 rounded border border-indigo-500/30 w-64 text-center font-bold flex items-center justify-center gap-2"><Cpu size={14}/> 2. Calculation Engines</div>
             <p className="text-slate-500 text-[9px] w-64 text-center mt-1 mb-2">Math-only processing. Calculates RSI, Trend, Volume without emotion.</p>
             <div className="h-6 w-px bg-slate-700 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

             <div className="bg-fuchsia-500/10 text-fuchsia-400 px-4 py-2 rounded border border-fuchsia-500/30 w-64 text-center font-bold flex items-center justify-center gap-2"><Bot size={14}/> 3. AI Agent Council</div>
             <p className="text-slate-500 text-[9px] w-64 text-center mt-1 mb-2">Multiple AI models (ChatGPT, Claude, Gemini) review the math and debate the strategy.</p>
             <div className="h-6 w-px bg-slate-700 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

             <div className="bg-amber-500/10 text-amber-400 px-4 py-2 rounded border border-amber-500/30 w-64 text-center font-bold flex items-center justify-center gap-2"><Scale size={14}/> 4. Consensus Engine</div>
             <p className="text-slate-500 text-[9px] w-64 text-center mt-1 mb-2">Aggregates all AI votes. Requires 80%+ agreement to proceed.</p>
             <div className="h-6 w-px bg-slate-700 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

             <div className="bg-rose-500/10 text-rose-400 px-4 py-2 rounded border border-rose-500/30 w-64 text-center font-bold flex items-center justify-center gap-2"><ShieldCheck size={14}/> 5. Risk Engine</div>
             <p className="text-slate-500 text-[9px] w-64 text-center mt-1 mb-2">Calculates max allowed loss based on your account size. Determines exact shares to buy.</p>
             <div className="h-6 w-px bg-slate-700 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

             <div className="bg-emerald-500/10 text-emerald-400 px-4 py-2 rounded border border-emerald-500/30 w-64 text-center font-bold flex items-center justify-center gap-2"><Activity size={14}/> 6. Broker API Execution</div>
             <p className="text-slate-500 text-[9px] w-64 text-center mt-1 mb-2">Sends the exact trade instructions to the live stock exchange.</p>

          </div>

          <div className="flex justify-between mt-8">
            <button 
              onClick={() => setActiveSectionId("intro-basics")}
              className="text-slate-400 hover:text-white px-4 py-2 text-sm font-bold transition-colors"
            >
              Previous
            </button>
            <button 
              onClick={() => { markCompleted("arch-flow"); setActiveSectionId("quant-engines"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors"
            >
              Complete Module <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // QUANT ENGINES
    {
      id: "quant-engines",
      category: "2. The Intelligence Pipeline",
      title: "Calculation Engines",
      icon: <Cpu size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">Calculation Engines Explained</h2>
          <p className="text-slate-400 text-sm mb-6">
            Our platform doesn't just ask ChatGPT what to buy. That leads to hallucinations. Instead, raw data flows through dedicated <strong>Mathematical Engines</strong>. These provide hard, objective facts to the AI.
          </p>

          <div className="space-y-4">
            
            <div className="bg-[#111822] border-l-2 border-emerald-500 p-4 rounded-r-lg">
              <h3 className="text-emerald-400 font-bold mb-2 flex items-center gap-2"><TrendingUp size={16}/> Trend Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Identifies the overarching direction of the market (up, down, or sideways).</p>
              <div className="grid grid-cols-3 gap-4 text-[10px] font-mono bg-[#1A1F2B] p-3 rounded">
                 <div><span className="text-slate-500 block">Inputs</span>Price, Moving Averages</div>
                 <div><span className="text-slate-500 block">Outputs</span>Trend: Bullish (87%)</div>
                 <div><span className="text-slate-500 block">AI Uses It For</span>Confirming we don't trade against the trend.</div>
              </div>
            </div>

            <div className="bg-[#111822] border-l-2 border-indigo-500 p-4 rounded-r-lg">
              <h3 className="text-indigo-400 font-bold mb-2 flex items-center gap-2"><Activity size={16}/> Momentum Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Measures the speed and strength of price changes using indicators like RSI and MACD.</p>
              <div className="grid grid-cols-3 gap-4 text-[10px] font-mono bg-[#1A1F2B] p-3 rounded">
                 <div><span className="text-slate-500 block">Inputs</span>RSI, Price ROC</div>
                 <div><span className="text-slate-500 block">Outputs</span>Status: Overbought</div>
                 <div><span className="text-slate-500 block">AI Uses It For</span>Timing entries (avoiding buying at the top).</div>
              </div>
            </div>

            <div className="bg-[#111822] border-l-2 border-sky-500 p-4 rounded-r-lg">
              <h3 className="text-sky-400 font-bold mb-2 flex items-center gap-2"><BarChart3 size={16}/> Volume Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Analyzes how much of the stock is being traded. High volume means institutions (smart money) are involved.</p>
              <div className="grid grid-cols-3 gap-4 text-[10px] font-mono bg-[#1A1F2B] p-3 rounded">
                 <div><span className="text-slate-500 block">Inputs</span>Tick Volume, OBV</div>
                 <div><span className="text-slate-500 block">Outputs</span>Relative Vol: 2.4x</div>
                 <div><span className="text-slate-500 block">AI Uses It For</span>Verifying that a price breakout is real, not fake.</div>
              </div>
            </div>

            <div className="bg-[#111822] border-l-2 border-purple-500 p-4 rounded-r-lg">
              <h3 className="text-purple-400 font-bold mb-2 flex items-center gap-2"><Zap size={16}/> Volatility Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Measures how wild the price swings are. Uses Average True Range (ATR) and Bollinger Bands.</p>
              <div className="grid grid-cols-3 gap-4 text-[10px] font-mono bg-[#1A1F2B] p-3 rounded">
                 <div><span className="text-slate-500 block">Inputs</span>ATR, VIX</div>
                 <div><span className="text-slate-500 block">Outputs</span>ATR: $4.20</div>
                 <div><span className="text-slate-500 block">AI Uses It For</span>Setting stop losses so normal swings don't stop you out.</div>
              </div>
            </div>
          </div>
        </div>
      )
    },

    // AI COUNCIL
    {
      id: "ai-council",
      category: "2. The Intelligence Pipeline",
      title: "AI Agent Collaboration",
      icon: <BrainCircuit size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">How Multiple AI Agents Work Together</h2>
          <p className="text-slate-300 text-sm mb-6">
            The platform does not rely on a single AI model. Single models can be biased or hallucinate. Instead, we use an <strong>Agent Council</strong>.
          </p>
          
          <div className="bg-[#111822] border border-slate-800 rounded-lg p-5">
            <h3 className="text-white font-bold mb-4 flex items-center gap-2"><MessageSquare size={16} className="text-amber-400"/> The Debate System</h3>
            
            <div className="space-y-4 font-mono text-[10px]">
              <div className="p-3 bg-slate-800/50 rounded border border-slate-700">
                <span className="text-sky-400 font-bold block mb-1">ChatGPT (The Optimist)</span>
                <span className="text-slate-300">"The trend engine shows a strong bullish breakout. Earnings are positive. I recommend BUY."</span>
              </div>
              
              <div className="p-3 bg-slate-800/50 rounded border border-slate-700">
                <span className="text-fuchsia-400 font-bold block mb-1">Claude (The Risk Assessor)</span>
                <span className="text-slate-300">"I agree with the trend, but the Volume engine shows volume is decreasing. We might be buying the top. I recommend HOLD."</span>
              </div>
              
              <div className="p-3 bg-slate-800/50 rounded border border-slate-700">
                <span className="text-emerald-400 font-bold block mb-1">Gemini (The Historical Analyst)</span>
                <span className="text-slate-300">"Looking at the Memory Engine, the last 3 times this happened with decreasing volume, the stock dropped 5%. HOLD."</span>
              </div>
              
              <div className="flex justify-center my-2 text-slate-500"><ArrowDown size={14}/></div>
              
              <div className="p-3 bg-indigo-500/10 border border-indigo-500/30 rounded text-center">
                <span className="text-indigo-400 font-bold block mb-1 uppercase tracking-widest">Consensus Engine Decision</span>
                <span className="text-white text-sm">TRADE REJECTED (2 HOLD vs 1 BUY)</span>
              </div>
            </div>
          </div>
          
          <div className="bg-emerald-500/10 border border-emerald-500/20 p-5 rounded-lg mt-6">
            <h4 className="text-emerald-400 font-bold mb-2">Math + AI = Success</h4>
            <p className="text-slate-300 text-xs leading-relaxed">
              The Calculation Engine provides the objective math (RSI: 62, Trend: Up). The AI Agents provide the context (RSI is 62, but there's a major Federal Reserve speech tomorrow, so we shouldn't buy). Both are required for high-quality decisions.
            </p>
          </div>
        </div>
      )
    },

    // SIMULATOR
    {
      id: "simulator",
      category: "3. Practice & Safety",
      title: "Trading Simulator Tutorial",
      icon: <PlayCircle size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">Practice Before You Risk</h2>
          <p className="text-slate-300 text-sm mb-6">
            Before connecting a real brokerage account, you can use the built-in <strong>Trading Simulator</strong> (Paper Trading).
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-[#111822] border border-slate-800 rounded-lg p-5">
               <h3 className="text-white font-bold mb-3 flex items-center gap-2"><Wallet size={16} className="text-emerald-400"/> Virtual Money</h3>
               <p className="text-slate-400 text-xs mb-4">Start with a virtual $100,000 portfolio to test strategies without real financial risk.</p>
               <button className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs font-bold transition-colors">
                 Reset Virtual Balance to $100k
               </button>
            </div>

            <div className="bg-[#111822] border border-slate-800 rounded-lg p-5">
               <h3 className="text-white font-bold mb-3 flex items-center gap-2"><Activity size={16} className="text-indigo-400"/> Replay Mode</h3>
               <p className="text-slate-400 text-xs mb-4">You can rewind the market to a specific date in the past and watch how the AI Agents would have reacted live.</p>
               <button onClick={() => setActiveTab("command")} className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold transition-colors">
                 Open Replay Dashboard
               </button>
            </div>
          </div>

          <div className="bg-rose-500/10 border border-rose-500/20 p-5 rounded-lg mt-6">
            <h4 className="text-rose-400 font-bold mb-2 flex items-center gap-2"><AlertTriangle size={16}/> Important Safety Notice</h4>
            <ul className="list-disc list-inside text-slate-300 text-xs space-y-2 leading-relaxed">
              <li><strong>AI is not guaranteed:</strong> No matter how confident the AI is, it can and will be wrong sometimes.</li>
              <li><strong>Always use Stop Losses:</strong> A Stop Loss automatically sells your position if it drops by a certain percentage, preventing a total wipeout. Our Risk Engine enforces this automatically.</li>
              <li><strong>Past Performance !== Future Results:</strong> A strategy that won 80% of trades last month might lose this month if the overall market regime changes.</li>
              <li><strong>Start Small:</strong> When you move to real money, start with a tiny amount until you trust the automated execution.</li>
            </ul>
          </div>
        </div>
      )
    }
  ];

  // Group sections by category
  const categories = Array.from(new Set(sections.map(s => s.category)));

  const activeSection = sections.find(s => s.id === activeSectionId) || sections[0];

  const ArrowDown = ({size, className}: {size: number, className?: string}) => (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
  );

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] animate-fade-in bg-[#0A0F16]">
      {/* Top Header */}
      <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center bg-[#1A1F2B] shrink-0">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <BookOpen size={20} className="text-indigo-400" />
            Argus Learning & Documentation Center
          </h2>
          <p className="text-[11px] text-slate-400 font-mono mt-1">Interactive Academy & Platform Knowledge Base</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input 
              type="text" 
              placeholder="Search concepts, engines..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-[#111822] border border-slate-800 text-slate-300 text-xs rounded-full pl-9 pr-4 py-1.5 focus:outline-none focus:border-indigo-500 w-64"
            />
          </div>
          <button 
            onClick={() => setActiveTab("command")}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar Navigation */}
        <div className="w-64 border-r border-slate-800 bg-[#111822] flex flex-col overflow-y-auto">
          <div className="p-4 border-b border-slate-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-widest">Course Progress</span>
              <span className="text-emerald-400 text-xs font-bold font-mono">{Math.round((Object.keys(completedModules).length / sections.filter(s=>s.isCourse).length) * 100)}%</span>
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div 
                className="bg-emerald-500 h-full transition-all duration-500" 
                style={{ width: \`\${(Object.keys(completedModules).length / sections.filter(s=>s.isCourse).length) * 100}%\` }}
              ></div>
            </div>
          </div>
          
          <div className="flex-1 py-4">
            {categories.map((category, i) => (
              <div key={i} className="mb-6">
                <h3 className="px-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 font-mono">
                  {category}
                </h3>
                <div className="space-y-0.5">
                  {sections.filter(s => s.category === category).map(section => (
                    <button
                      key={section.id}
                      onClick={() => setActiveSectionId(section.id)}
                      className={\`w-full text-left px-4 py-2 text-xs flex items-center justify-between transition-colors \${
                        activeSectionId === section.id 
                          ? "bg-indigo-500/10 text-indigo-400 border-r-2 border-indigo-500" 
                          : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                      }\`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className={activeSectionId === section.id ? "text-indigo-400" : "text-slate-500"}>
                          {section.icon}
                        </span>
                        {section.title}
                      </div>
                      {section.isCourse && (
                        completedModules[section.id] 
                          ? <CheckCircle2 size={12} className="text-emerald-500" />
                          : <Circle size={10} className="text-slate-600" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto bg-[#0A0F16] p-8 lg:p-12 relative">
           
           {/* Background decorative elements */}
           <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-indigo-500/5 blur-[120px] rounded-full pointer-events-none"></div>
           
           <div className="max-w-4xl mx-auto relative z-10">
              {activeSection.content}
           </div>

        </div>
      </div>
    </div>
  );
};

export default DocumentationTab;
`;

fs.writeFileSync('src/components/DocumentationTab.tsx', content);
console.log("Successfully regenerated DocumentationTab");
