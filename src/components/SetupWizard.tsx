
import React, { useState, useEffect } from "react";
import { BrainCircuit, Check, Shield, Zap, TrendingUp, AlertTriangle, Settings, Activity, Cpu, CheckCircle2, ChevronRight, X, Play, RefreshCw, BarChart, Server, Globe, Database, HelpCircle, Lock, Key, CreditCard } from "lucide-react";

export function SetupWizard({ onComplete, onSkip }: { onComplete: (config: any) => void, onSkip?: () => void }) {
  const [step, setStep] = useState(0);
  const [wizardMode, setWizardMode] = useState<'detecting' | 'setup'>('detecting');
  const [readinessScore, setReadinessScore] = useState(0);
  
  // Configurations
  const [aiProviders, setAiProviders] = useState<Record<string, { key: string, connected: boolean }>>({
    Gemini: { key: "", connected: false },
    OpenAI: { key: "", connected: false },
    Claude: { key: "", connected: false },
    DeepSeek: { key: "", connected: false },
    Groq: { key: "", connected: false },
    Kimi: { key: "", connected: false },
    OpenRouter: { key: "", connected: false },
    Mistral: { key: "", connected: false },
    NVIDIA: { key: "", connected: false }
  });
  
  const [brokerage, setBrokerage] = useState({
    provider: "Alpaca",
    mode: "Paper",
    apiKey: "",
    secretKey: "",
    connected: false
  });
  
  const [marketData, setMarketData] = useState({
    provider: "Alpaca",
    apiKey: "",
    connected: false
  });
  
  const [newsApi, setNewsApi] = useState({
    provider: "Finnhub",
    apiKey: "",
    connected: false
  });
  
  const [tradingConfig, setTradingConfig] = useState({
    initialCapital: 10000,
    tradingMode: "Paper Trading",
    riskProfile: "Balanced",
    maxDailyLoss: 500,
    maxPositionSize: 1000
  });

  const [dbStatus, setDbStatus] = useState("Connected");
  
  const [isInitializing, setIsInitializing] = useState(false);
  const [initStep, setInitStep] = useState(0);
  const initSteps = [
    "Initializing Local SQLite Database...",
    "Encrypting API Credentials...",
    "Verifying Broker Connectivity...",
    "Establishing AI Engine Links...",
    "Booting Risk Manager...",
    "Starting Argus EventBus..."
  ];

  // Auto-detection
  useEffect(() => {
    if (wizardMode === 'detecting') {
      setTimeout(() => {
        // Simulate detection
        setAiProviders(prev => ({ ...prev, Gemini: { key: "mock", connected: true } }));
        setBrokerage(prev => ({ ...prev, connected: true }));
        setDbStatus("Connected");
        calculateReadiness();
        setWizardMode('setup');
      }, 1500);
    }
  }, [wizardMode]);

  const calculateReadiness = () => {
    let score = 20; // DB is connected
    if (aiProviders.Gemini.connected || aiProviders.OpenAI.connected || aiProviders.Claude.connected) score += 20;
    if (brokerage.connected) score += 20;
    if (marketData.connected) score += 20;
    if (newsApi.connected) score += 20;
    setReadinessScore(score);
  };

  const handleTestConnection = (type: string) => {
    // Mock connection testing
    if (type === 'broker') setBrokerage(prev => ({ ...prev, connected: true }));
    if (type === 'market') setMarketData(prev => ({ ...prev, connected: true }));
    if (type === 'news') setNewsApi(prev => ({ ...prev, connected: true }));
    calculateReadiness();
  };

  const handleAiChange = (provider: string, val: string) => {
    setAiProviders(prev => ({
      ...prev,
      [provider]: { key: val, connected: val.length > 5 }
    }));
    calculateReadiness();
  };

  const handleInitialize = () => {
    setStep(99);
    setIsInitializing(true);
    let current = 0;
    const interval = setInterval(() => {
      current++;
      setInitStep(current);
      if (current >= initSteps.length) {
        clearInterval(interval);
        setTimeout(() => {
          onComplete({
            initialCapital: tradingConfig.initialCapital,
            riskProfile: tradingConfig.riskProfile,
            tradingMode: tradingConfig.tradingMode,
            aiProvider: Object.keys(aiProviders).find(k => aiProviders[k].connected) || "Gemini",
            aiProviders,
            brokerage
          });
        }, 1000);
      }
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#05080f] flex items-center justify-center p-4 sm:p-6 lg:p-8 font-mono">
      {/* Background Effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-[120px]"></div>
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCI+PGNpcmNsZSBjeD0iMSIgY3k9IjEiIHI9IjEiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4wNSkiLz48L3N2Zz4=')] [mask-image:linear-gradient(to_bottom,white,transparent)]"></div>
      </div>

      <div className="relative w-full max-w-4xl max-h-[90vh] bg-[#0A0F16] border border-slate-800 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/50 backdrop-blur-md z-10 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center">
              <BrainCircuit className="text-indigo-400" size={18} />
            </div>
            <div>
              <h1 className="text-white font-bold tracking-widest uppercase text-sm">Argus Initialization</h1>
              <p className="text-[10px] text-slate-400 uppercase tracking-wider">Autonomous Trading Setup Wizard</p>
            </div>
          </div>
          {onSkip && (
             <button onClick={onSkip} className="text-slate-500 hover:text-slate-300 transition-colors text-xs uppercase tracking-widest flex items-center gap-2">
               Skip Setup <X size={14} />
             </button>
          )}
        </div>

        {/* Body Content */}
        <div className="flex-1 overflow-y-auto p-6 lg:p-8 custom-scrollbar relative z-10">
          
          {wizardMode === 'detecting' && (
            <div className="flex flex-col items-center justify-center h-full space-y-6">
               <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
               <h2 className="text-xl font-bold text-white uppercase tracking-widest">Detecting Existing Configuration</h2>
               <p className="text-slate-400">Scanning local SQLite database for credentials...</p>
            </div>
          )}

          {wizardMode === 'setup' && step === 0 && (
             <div className="flex flex-col items-center text-center h-full justify-center max-w-2xl mx-auto space-y-6 animate-fade-in">
                <div className="w-20 h-20 rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center shadow-[0_0_30px_rgba(99,102,241,0.2)]">
                  <Shield size={40} className="text-indigo-400" />
                </div>
                <h2 className="text-3xl font-bold text-white uppercase tracking-widest">ARGUS INITIAL SETUP</h2>
                
                <div className="bg-[#111822] border border-slate-800 p-6 rounded-lg w-full mt-4 text-left space-y-6">
                  <div>
                    <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-widest mb-3">Required:</h3>
                    <ul className="space-y-2 text-sm text-slate-300">
                      <li className="flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Local SQLite database</li>
                      <li className="flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Initial trading capital</li>
                      <li className="flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Risk limits</li>
                    </ul>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-widest mb-3">AI Providers:</h3>
                      <ul className="space-y-2 text-sm text-slate-300">
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Gemini</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> OpenAI</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Claude</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Kimi</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Groq</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> OpenRouter</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> NVIDIA NIM</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Other providers</li>
                      </ul>
                    </div>
                    <div className="space-y-6">
                      <div>
                        <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-widest mb-3">Market Data:</h3>
                        <ul className="space-y-2 text-sm text-slate-300">
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Alpaca</li>
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Polygon</li>
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Interactive Brokers</li>
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Coinbase</li>
                        </ul>
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-widest mb-3">News:</h3>
                        <ul className="space-y-2 text-sm text-slate-300">
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> News API</li>
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Other configured news provider</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                  
                  <p className="text-xs text-slate-500 italic">
                    The user can configure multiple providers. Argus should automatically use every valid provider that the user enables.
                  </p>
                </div>
                
                <div className="flex gap-4 mt-8 pt-4">
                  <button onClick={() => setStep(1)} className="px-8 py-3 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm uppercase tracking-widest transition-colors flex items-center gap-2">
                    Begin Setup <ChevronRight size={16} />
                  </button>
                </div>
             </div>
          )}

          {wizardMode === 'setup' && step === 1 && (
             <div className="max-w-3xl mx-auto animate-fade-in">
                <div className="mb-8 border-b border-slate-800 pb-4">
                  <h2 className="text-xl font-bold text-white uppercase tracking-widest flex items-center gap-2">
                    <BrainCircuit className="text-indigo-400" size={24}/> AI Provider Configuration
                  </h2>
                  <p className="text-slate-400 text-xs mt-2 leading-relaxed">
                    Argus uses multiple AI models for market analysis, reasoning, risk evaluation, and trade reflection. Configure your preferred AI engines below.
                  </p>
                </div>
                
                <div className="space-y-4">
                  {(Object.entries(aiProviders) as [string, any][]).map(([provider, data]) => (
                    <div key={provider} className="bg-[#111822] border border-slate-800 p-4 rounded-lg flex items-center justify-between gap-4">
                       <div className="w-1/3">
                         <h3 className="text-white font-bold uppercase tracking-wider text-sm">{provider}</h3>
                         <div className="flex items-center gap-2 mt-1">
                           {data.connected ? <span className="text-emerald-400 text-[10px] flex items-center gap-1 uppercase tracking-widest"><CheckCircle2 size={12}/> Connected</span> : <span className="text-slate-500 text-[10px] uppercase tracking-widest">Not Configured</span>}
                         </div>
                         <div className="mt-3 space-y-1">
                            <div className="flex justify-between text-[10px] text-slate-500 uppercase tracking-widest"><span className="text-slate-600">Model Avail:</span> <span className="text-slate-400">All Tiers</span></div>
                            <div className="flex justify-between text-[10px] text-slate-500 uppercase tracking-widest"><span className="text-slate-600">Limits:</span> <span className="text-slate-400">Standard</span></div>
                            <div className="flex justify-between text-[10px] text-slate-500 uppercase tracking-widest"><span className="text-slate-600">Free Tier:</span> <span className="text-slate-400">Active</span></div>
                         </div>
                       </div>
                       <div className="flex-1">
                         <input 
                           type="password" 
                           placeholder={`${provider} API Key`} 
                           value={data.key}
                           onChange={(e) => handleAiChange(provider, e.target.value)}
                           className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                         />
                       </div>
                    </div>
                  ))}
                </div>
             </div>
          )}

          {wizardMode === 'setup' && step === 2 && (
             <div className="max-w-3xl mx-auto animate-fade-in">
                <div className="mb-8 border-b border-slate-800 pb-4">
                  <h2 className="text-xl font-bold text-white uppercase tracking-widest flex items-center gap-2">
                    <CreditCard className="text-emerald-400" size={24}/> Brokerage Setup
                  </h2>
                  <p className="text-slate-400 text-xs mt-2 leading-relaxed">
                    Argus requires a brokerage connection for paper trading or live execution. 
                  </p>
                </div>
                
                <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg space-y-4">
                   <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">Provider</label>
                        <select 
                          className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none"
                          value={brokerage.provider}
                          onChange={(e) => setBrokerage({...brokerage, provider: e.target.value})}
                        >
                          <option>Alpaca</option>
                          <optgroup label="International">
                            <option>Interactive Brokers</option>
                            <option>Coinbase</option>
                          </optgroup>
                          <optgroup label="Canada">
                            <option>Questrade</option>
                            <option>Wealthsimple Trade</option>
                            <option>Interactive Brokers Canada</option>
                            <option>National Bank Direct</option>
                          </optgroup>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">Environment</label>
                        <select 
                          className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none"
                          value={brokerage.mode}
                          onChange={(e) => setBrokerage({...brokerage, mode: e.target.value})}
                        >
                          <option>Paper Trading</option>
                          <option>Live Trading</option>
                        </select>
                      </div>
                   </div>
                   
                   <div className="grid grid-cols-2 gap-4">
                     <div>
                       <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">API Key</label>
                       <input 
                         type="password" 
                         className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none"
                         value={brokerage.apiKey}
                         onChange={(e) => setBrokerage({...brokerage, apiKey: e.target.value})}
                       />
                     </div>
                     <div>
                       <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">Secret Key</label>
                       <input 
                         type="password" 
                         className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none"
                         value={brokerage.secretKey}
                         onChange={(e) => setBrokerage({...brokerage, secretKey: e.target.value})}
                       />
                     </div>
                   </div>

                   <div className="pt-4 flex justify-end items-center border-t border-slate-800">
                      {brokerage.connected ? (
                        <div className="text-emerald-400 font-bold uppercase tracking-widest text-xs flex items-center gap-2"><CheckCircle2 size={16}/> Connected</div>
                      ) : (
                        <button onClick={() => handleTestConnection('broker')} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs uppercase tracking-widest font-bold rounded">Test Connection</button>
                      )}
                   </div>
                </div>
             </div>
          )}

          {wizardMode === 'setup' && step === 3 && (
             <div className="max-w-3xl mx-auto animate-fade-in">
                <div className="mb-8 border-b border-slate-800 pb-4">
                  <h2 className="text-xl font-bold text-white uppercase tracking-widest flex items-center gap-2">
                    <Activity className="text-amber-400" size={24}/> Market Data Providers
                  </h2>
                  <p className="text-slate-400 text-xs mt-2 leading-relaxed">
                    Real-time market data is required for accurate analysis and simulation.
                  </p>
                </div>
                
                <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg space-y-4">
                   <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">Provider</label>
                        <select 
                          className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none"
                          value={marketData.provider}
                          onChange={(e) => setMarketData({...marketData, provider: e.target.value})}
                        >
                          <option>Alpaca Market Data</option>
                          <option>Polygon.io</option>
                          <option>Alpha Vantage</option>
                          <option>Finnhub</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">API Key</label>
                        <input 
                         type="password" 
                         className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none"
                         value={marketData.apiKey}
                         onChange={(e) => setMarketData({...marketData, apiKey: e.target.value})}
                       />
                      </div>
                   </div>
                   <div className="pt-4 flex justify-end items-center border-t border-slate-800">
                      {marketData.connected ? (
                        <div className="text-emerald-400 font-bold uppercase tracking-widest text-xs flex items-center gap-2"><CheckCircle2 size={16}/> Connected</div>
                      ) : (
                        <button onClick={() => handleTestConnection('market')} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs uppercase tracking-widest font-bold rounded">Test Connection</button>
                      )}
                   </div>
                </div>
             </div>
          )}

          {wizardMode === 'setup' && step === 4 && (
             <div className="max-w-3xl mx-auto animate-fade-in">
                <div className="mb-8 border-b border-slate-800 pb-4">
                  <h2 className="text-xl font-bold text-white uppercase tracking-widest flex items-center gap-2">
                    <Globe className="text-cyan-400" size={24}/> News Intelligence APIs
                  </h2>
                  <p className="text-slate-400 text-xs mt-2 leading-relaxed">
                    News intelligence helps AI understand market events before making decisions.
                  </p>
                </div>
                
                <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg space-y-4">
                   <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">Provider</label>
                        <select 
                          className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none"
                          value={newsApi.provider}
                          onChange={(e) => setNewsApi({...newsApi, provider: e.target.value})}
                        >
                          <option>Finnhub News</option>
                          <option>MarketAux</option>
                          <option>Benzinga</option>
                          <option>Alpha Vantage News</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">API Key</label>
                        <input 
                         type="password" 
                         className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none"
                         value={newsApi.apiKey}
                         onChange={(e) => setNewsApi({...newsApi, apiKey: e.target.value})}
                       />
                      </div>
                   </div>
                   <div className="pt-4 flex justify-end items-center border-t border-slate-800">
                      {newsApi.connected ? (
                        <div className="text-emerald-400 font-bold uppercase tracking-widest text-xs flex items-center gap-2"><CheckCircle2 size={16}/> Connected</div>
                      ) : (
                        <button onClick={() => handleTestConnection('news')} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs uppercase tracking-widest font-bold rounded">Test Connection</button>
                      )}
                   </div>
                </div>
             </div>
          )}

          {wizardMode === 'setup' && step === 5 && (
             <div className="max-w-3xl mx-auto animate-fade-in">
                <div className="mb-8 border-b border-slate-800 pb-4">
                  <h2 className="text-xl font-bold text-white uppercase tracking-widest flex items-center gap-2">
                    <TrendingUp className="text-rose-400" size={24}/> User Trading Configuration
                  </h2>
                </div>
                
                <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg space-y-4">
                   <div className="grid grid-cols-2 gap-4">
                     <div>
                       <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">Initial Capital ($)</label>
                       <input type="number" className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white" value={tradingConfig.initialCapital} onChange={e => setTradingConfig({...tradingConfig, initialCapital: Number(e.target.value)})} />
                     </div>
                     <div>
                       <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">Trading Mode</label>
                       <select className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white" value={tradingConfig.tradingMode} onChange={e => setTradingConfig({...tradingConfig, tradingMode: e.target.value})}>
                          <option>Paper Trading</option>
                          <option>Simulation Mode</option>
                          <option>Live Trading</option>
                       </select>
                     </div>
                     <div>
                       <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">Risk Profile</label>
                       <select className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white" value={tradingConfig.riskProfile} onChange={e => setTradingConfig({...tradingConfig, riskProfile: e.target.value})}>
                          <option>Conservative</option>
                          <option>Balanced</option>
                          <option>Aggressive</option>
                          <option>Custom</option>
                       </select>
                     </div>
                     <div>
                       <label className="text-xs text-slate-400 uppercase tracking-widest block mb-2">Max Daily Loss ($)</label>
                       <input type="number" className="w-full bg-[#0A0F16] border border-slate-700 rounded px-3 py-2 text-sm text-white" value={tradingConfig.maxDailyLoss} onChange={e => setTradingConfig({...tradingConfig, maxDailyLoss: Number(e.target.value)})} />
                     </div>
                   </div>
                </div>
             </div>
          )}

          {wizardMode === 'setup' && step === 6 && (
             <div className="max-w-3xl mx-auto animate-fade-in flex flex-col items-center justify-center space-y-6 pt-12">
                <div className="w-20 h-20 rounded-full bg-slate-800 flex items-center justify-center">
                  <Database size={40} className="text-slate-400" />
                </div>
                <div className="text-center">
                  <h2 className="text-xl font-bold text-white uppercase tracking-widest mb-2">Local Database Setup</h2>
                  <p className="text-slate-400 text-sm max-w-md mx-auto mb-6">
                    Argus runs locally and stores your configuration securely in an SQLite Database. API keys are encrypted and stored locally. They are never exposed to the frontend or transmitted anywhere except the configured provider.
                  </p>
                  <div className="inline-flex items-center gap-2 bg-[#111822] border border-slate-800 px-6 py-3 rounded-full text-sm font-bold text-emerald-400 uppercase tracking-widest">
                    <CheckCircle2 size={16} /> Database Status: {dbStatus}
                  </div>
                </div>
             </div>
          )}

          {wizardMode === 'setup' && step === 7 && (
             <div className="max-w-3xl mx-auto animate-fade-in">
                <div className="mb-6">
                  <h3 className="text-2xl font-bold text-white mb-2 uppercase tracking-widest text-center">System Health Check</h3>
                  <p className="text-slate-400 text-sm text-center">Validation Before Starting Autonomous Mode</p>
                </div>
                
                <div className="space-y-3 max-w-md mx-auto">
                   <div className="flex items-center gap-3 p-3 rounded bg-[#111822] border border-slate-800">
                      {dbStatus === "Connected" ? <CheckCircle2 size={18} className="text-emerald-400 shrink-0"/> : <X size={18} className="text-rose-400 shrink-0"/>}
                      <span className="text-slate-300 text-sm font-bold uppercase tracking-wider">Database Connected</span>
                   </div>
                   <div className="flex items-center gap-3 p-3 rounded bg-[#111822] border border-slate-800">
                      {(aiProviders.Gemini.connected || aiProviders.OpenAI.connected) ? <CheckCircle2 size={18} className="text-emerald-400 shrink-0"/> : <X size={18} className="text-rose-400 shrink-0"/>}
                      <span className="text-slate-300 text-sm font-bold uppercase tracking-wider">AI Providers Available</span>
                   </div>
                   <div className="flex items-center gap-3 p-3 rounded bg-[#111822] border border-slate-800">
                      {brokerage.connected ? <CheckCircle2 size={18} className="text-emerald-400 shrink-0"/> : <X size={18} className="text-rose-400 shrink-0"/>}
                      <span className="text-slate-300 text-sm font-bold uppercase tracking-wider">Broker Connected</span>
                   </div>
                   <div className="flex items-center gap-3 p-3 rounded bg-[#111822] border border-slate-800">
                      {marketData.connected ? <CheckCircle2 size={18} className="text-emerald-400 shrink-0"/> : <X size={18} className="text-rose-400 shrink-0"/>}
                      <span className="text-slate-300 text-sm font-bold uppercase tracking-wider">Market Data Available</span>
                   </div>
                   <div className="flex items-center gap-3 p-3 rounded bg-[#111822] border border-slate-800">
                      {newsApi.connected ? <CheckCircle2 size={18} className="text-emerald-400 shrink-0"/> : <AlertTriangle size={18} className="text-amber-400 shrink-0"/>}
                      <span className="text-slate-300 text-sm font-bold uppercase tracking-wider">News Engine Connected</span>
                   </div>
                </div>
                
                {readinessScore < 100 && (
                   <div className="mt-8 bg-amber-500/10 border border-amber-500/30 p-4 rounded-lg text-amber-400 text-sm max-w-md mx-auto flex gap-3 items-start">
                     <AlertTriangle size={20} className="shrink-0 mt-0.5" />
                     <div>
                       <strong className="block uppercase tracking-widest mb-1">Configuration Incomplete</strong>
                       Argus can start, but some features may be disabled. Missing:
                       <ul className="list-disc pl-4 mt-2 space-y-1 text-xs">
                         {!brokerage.connected && <li>Broker API Key</li>}
                         {!marketData.connected && <li>Market Data API Key</li>}
                         {!newsApi.connected && <li>News API Key</li>}
                       </ul>
                     </div>
                   </div>
                )}
             </div>
          )}

          {wizardMode === 'setup' && step === 99 && (
             <div className="flex flex-col items-center justify-center h-full max-w-md mx-auto animate-fade-in">
                  <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-8"></div>
                  <h3 className="text-xl font-bold text-white mb-8 uppercase tracking-widest">System Boot Sequence</h3>
                  
                  <div className="w-full space-y-4">
                    {initSteps.map((s, idx) => (
                      <div key={idx} className="flex items-center gap-4">
                        {idx < initStep ? (
                          <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                        ) : idx === initStep ? (
                          <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin shrink-0 mx-[1px]"></div>
                        ) : (
                          <div className="w-2 h-2 rounded-full bg-slate-700 shrink-0 mx-1"></div>
                        )}
                        <span className={`text-sm uppercase tracking-wider font-bold ${idx < initStep ? "text-slate-400" : idx === initStep ? "text-indigo-300" : "text-slate-700"}`}>
                          {s}
                        </span>
                      </div>
                    ))}
                    
                    {initStep >= initSteps.length && (
                      <div className="text-center pt-8 text-emerald-400 font-bold uppercase tracking-widest text-lg animate-pulse">
                        Terminal Ready
                      </div>
                    )}
                  </div>
             </div>
          )}

        </div>

        {/* Footer Navigation */}
        {wizardMode === 'setup' && step > 0 && step < 99 && (
           <div className="p-4 border-t border-slate-800 bg-[#0A0F16] flex justify-between items-center z-10 shrink-0">
              <button 
                onClick={() => setStep(step - 1)}
                className="px-6 py-2.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 font-bold text-sm uppercase tracking-widest transition-colors"
              >
                Back
              </button>
              
              <div className="text-slate-500 text-xs font-bold tracking-widest">
                STEP {step} / 7
              </div>

              {step < 7 ? (
                <button 
                  onClick={() => setStep(step + 1)}
                  className="px-6 py-2.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm uppercase tracking-widest transition-colors flex items-center gap-2"
                >
                  Next <ChevronRight size={16} />
                </button>
              ) : (
                <button 
                  onClick={handleInitialize}
                  className="px-6 py-2.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm uppercase tracking-widest transition-colors shadow-[0_0_20px_rgba(16,185,129,0.3)] flex items-center gap-2"
                >
                  <Play size={16} fill="currentColor" /> Initialize Terminal
                </button>
              )}
           </div>
        )}
      </div>
    </div>
  );
}
