/**
 * ==========================================================
 * Module:
 * AIProviderManagement.tsx
 *
 * Purpose:
 * Core implementation and logic for the AIProviderManagement.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AIProviderManagementx
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */


import React, { useState, useEffect } from 'react';
import { Cpu, Server, Key, Clock, DollarSign, Activity, Zap, CheckCircle2, XCircle, Settings, ShieldAlert, BarChart3, Route, Layers, Network, ChevronRight, BrainCircuit } from 'lucide-react';

export default function AIProviderManagement() {
  const [activeSubTab, setActiveSubTab] = useState<'providers' | 'routing' | 'agents' | 'benchmarks' | 'costs' | 'playground'>('providers');
  const [providers, setProviders] = useState<any[]>([]);
  const [usage, setUsage] = useState<any[]>([]);
  
  useEffect(() => {
    fetch('/api/v1/config/providers')
      .then(res => res.json())
      .then(data => setProviders(data));
      
    fetch('/api/v1/config/usage')
      .then(res => res.json())
      .then(data => setUsage(data));
      
    // Set up WebSocket for real-time metrics
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'ai_metrics_update') {
                setUsage(prev => [data.payload, ...prev].slice(0, 100));
            }
        } catch(e) {}
    };
    return () => ws.close();
  }, []);

  const totalTokens = (Array.isArray(usage) ? usage : []).reduce((acc, curr) => acc + (curr.completionTokens || curr.tokens || 0), 0);
  const totalCost = (Array.isArray(usage) ? usage : []).reduce((acc, curr) => acc + (curr.cost || 0), 0);
  const successCount = (Array.isArray(usage) ? usage : []).filter(u => u.success !== false && (!u.responseStatus || !u.responseStatus.includes('error'))).length;
  const successRate = (Array.isArray(usage) ? usage : []).length > 0 ? Math.round((successCount / usage.length) * 100) : 100;

  return (
    <div className="flex flex-col gap-6 font-mono text-slate-200">
      
      {/* Sub-Navigation */}
      <div className="flex flex-wrap gap-2 mb-2">
        
        {[
          { id: 'providers', label: 'Providers & Keys', icon: <Key size={14} /> },
          { id: 'agents', label: 'Agent Routing', icon: <BrainCircuit size={14} /> },
          { id: 'routing', label: 'Smart Router', icon: <Route size={14} /> },
          { id: 'costs', label: 'Usage & Costs', icon: <DollarSign size={14} /> },
        ].map(tab => (

          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id as any)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold tracking-widest uppercase transition-all ${activeSubTab === tab.id ? 'bg-indigo-600 text-white shadow-[0_0_15px_rgba(79,70,229,0.4)]' : 'bg-[#111822] text-slate-400 hover:bg-slate-800 border border-slate-800'}`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {activeSubTab === 'providers' && (
        <div className="animate-fade-in flex flex-col gap-6">
          <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg border-l-4 border-l-indigo-500">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
                  <Network size={14} className="text-indigo-500" /> Universal AI Provider Network
                </h3>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">Configure access to commercial, aggregator, and local AI inference engines.</p>
              </div>
              <button onClick={() => {
    const provider = window.prompt("Provider Name (e.g. OpenRouter, OpenAI, Local LM Studio):");
    const model = window.prompt("Default Model (e.g. gpt-4o, mistral, llama3):");
    const apiKey = window.prompt("API Key (leave blank for local):");
    if (provider) {
      fetch('/api/v1/config/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model, apiKey })
      }).then(() => window.location.reload());
    }
  }} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-[10px] uppercase tracking-widest font-bold rounded transition-colors flex items-center gap-2">
                <Key size={12} /> Add Provider
              </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                 <div className="bg-[#0A0F16] border border-slate-800 p-4 rounded-lg flex flex-col">
                   <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Active Providers</div>
                   <div className="text-2xl font-bold text-indigo-400">{(Array.isArray(providers) ? providers : []).length}</div>
                 </div>
                 <div className="bg-[#0A0F16] border border-slate-800 p-4 rounded-lg flex flex-col">
                   <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Total Tokens</div>
                   <div className="text-2xl font-bold text-emerald-400">{totalTokens.toLocaleString()}</div>
                 </div>
                 <div className="bg-[#0A0F16] border border-slate-800 p-4 rounded-lg flex flex-col">
                   <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Network Health</div>
                   <div className="text-2xl font-bold text-sky-400">{successRate}%</div>
                 </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] text-slate-500 uppercase tracking-widest">
                    <th className="pb-3 font-medium">Provider</th>
                    <th className="pb-3 font-medium">Endpoint</th>
                    <th className="pb-3 font-medium">Avg Latency</th>
                    <th className="pb-3 font-medium">Success</th>
                    <th className="pb-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(Array.isArray(providers) ? providers : []).map(p => (
                  <tr key={p.id} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                    <td className="py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${p.health === 'Healthy' ? 'bg-emerald-500' : 'bg-rose-500'}`}></div>
                        <div>
                          <div className="text-xs font-bold text-slate-300">{p.providerName}</div>
                          <div className="text-[10px] text-slate-500 uppercase tracking-widest">Priority {p.priority}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 text-xs text-slate-400">{p.apiEndpoint || 'SDK Default'}</td>
                    <td className="py-4 text-xs font-mono text-amber-400">{Math.round(p.latency || 0)}ms</td>
                    <td className="py-4 text-xs text-slate-400">{p.successRate}%</td>
                    <td className="py-4 text-xs font-bold text-indigo-400">{p.health}</td>
                  </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      
      {activeSubTab === 'agents' && (
        <div className="animate-fade-in flex flex-col gap-6">
           <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg border-l-4 border-l-sky-500">
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest mb-4 flex items-center gap-2">
                <BrainCircuit size={14} className="text-sky-500" /> Multi-Agent Routing Table
              </h3>
              <p className="text-[10px] text-slate-400 uppercase tracking-widest mb-6">Assign specific AI providers to different trading agents to optimize cost, latency, and reasoning capability.</p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {['Technical', 'News', 'Fundamental', 'Macro', 'Risk', 'Reflection', 'Memory', 'Chief Trader', 'Market Regime', 'Options', 'Portfolio', 'Execution', 'Compliance', 'Performance', 'Cost Optimizer', 'Router'].map(agent => (
                      <div key={agent} className="bg-[#0A0F16] border border-slate-800 p-4 rounded-lg flex justify-between items-center">
                          <div className="text-xs font-bold text-slate-300">{agent} Agent</div>
                          <select 
                            className="bg-[#111822] border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 outline-none"
                            onChange={(e) => {
                                fetch('/api/v1/config/routing', {
                                   method: 'POST',
                                   headers: { 'Content-Type': 'application/json' },
                                   body: JSON.stringify({ agent, providerId: e.target.value })
                                }).then(() => {
                                   // Add toast or silent success
                                });
                            }}
                          >
                             <option value="auto">Auto-Select (Best Available)</option>
                             {(Array.isArray(providers) ? providers : []).map(p => (
                                <option key={p.id} value={p.id}>{p.providerName}</option>
                             ))}
                          </select>
                      </div>
                  ))}
              </div>
           </div>
        </div>
      )}

      {activeSubTab === 'routing' && (
        <div className="animate-fade-in flex flex-col gap-6">
           <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg border-l-4 border-l-emerald-500">
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Route size={14} className="text-emerald-500" /> Argus AI Router Logs
              </h3>
              <p className="text-[10px] text-slate-400 uppercase tracking-widest mb-6">Real-time routing decisions, failovers, and latency tracking.</p>
              
              <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] text-slate-500 uppercase tracking-widest">
                    <th className="pb-3 font-medium">Time</th>
                    <th className="pb-3 font-medium">Agent</th>
                    <th className="pb-3 font-medium">Provider & Model</th>
                    <th className="pb-3 font-medium">Latency</th>
                    <th className="pb-3 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {(Array.isArray(usage) ? usage : []).map((u, i) => (
                  <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                    <td className="py-4 text-xs text-slate-500">{new Date(u.timestamp || Date.now()).toLocaleTimeString()}</td>
                    <td className="py-4 text-xs text-sky-400 font-bold">{u.agent}</td>
                    <td className="py-4">
                        <div className="text-xs text-slate-300 font-bold">{u.provider}</div>
                        <div className="text-[10px] text-slate-500">{u.model}</div>
                    </td>
                    <td className="py-4 text-xs font-mono text-amber-400">{Math.round(u.latency || 0)}ms</td>
                    <td className="py-4 text-xs font-bold">
                        {u.responseStatus && u.responseStatus.includes('error') || u.success === false ? (
                           <span className="text-rose-500 flex items-center gap-1"><XCircle size={12} /> {u.responseStatus || u.error}</span>
                        ) : (
                           <span className="text-emerald-500 flex items-center gap-1"><CheckCircle2 size={12} /> Success</span>
                        )}
                    </td>
                  </tr>
                  ))}
                </tbody>
              </table>
            </div>
           </div>
        </div>
      )}
      
      {activeSubTab === 'costs' && (
        <div className="animate-fade-in flex flex-col gap-6">
           <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg border-l-4 border-l-amber-500">
              <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest mb-4 flex items-center gap-2">
                <DollarSign size={14} className="text-amber-500" /> Usage & Cost Monitoring
              </h3>
              <p className="text-[10px] text-slate-400 uppercase tracking-widest mb-6">Aggregate token usage across all providers.</p>
              
              <div className="flex justify-center py-10">
                 <div className="text-center">
                    <div className="text-4xl font-bold text-emerald-400 mb-2">${totalCost.toFixed(4)}</div>
                    <div className="text-xs text-slate-500 uppercase tracking-widest">Total API Spend</div>
                 </div>
              </div>
           </div>
        </div>
      )}
    </div>
  );
}
