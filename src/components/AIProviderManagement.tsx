/**
 * ==========================================================
 * Module:
 * AIProviderManagement.tsx
 *
 * Purpose:
 * Settings → Providers & Keys surface for the Argus AIRouter inventory.
 *
 * Responsibilities:
 * - List every known AI provider (DB rows + env catalog + local engines)
 * - Filter Active / Inactive (not in use) / All with honest usage status
 * - Show latency/success only when AIRouter has real call samples
 *
 * Inputs:
 * - GET /api/v1/config/providers (enriched inventory)
 * - GET /api/v1/config/usage
 *
 * Outputs:
 * - React UI for providers, agent routing, router logs, costs
 *
 * Never:
 * - Invent health metrics for unused / never-called providers
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import React, { useMemo, useState, useEffect } from 'react';
import { Key, DollarSign, Route, Network, BrainCircuit, CheckCircle2, XCircle } from 'lucide-react';
import { UnavailableHint } from './UnavailableHint';

type ProviderFilter = 'all' | 'active' | 'inactive';

type UsageStatus = 'active' | 'inactive' | 'no_credentials' | 'not_configured';

interface ProviderRow {
  id: string;
  providerName: string;
  apiEndpoint?: string | null;
  priority?: number | null;
  enabled?: boolean | null;
  health?: string | null;
  latency?: number | null;
  successRate?: number | null;
  requests?: number | null;
  usageStatus?: UsageStatus;
  hasCredentials?: boolean;
  credentialSource?: 'env' | 'database' | null;
  isLocal?: boolean;
  metricsAvailable?: boolean;
  latencyAvailable?: boolean;
  displayHealth?: string | null;
  healthNote?: string | null;
  inDatabase?: boolean;
}

const USAGE_STATUS_LABEL: Record<UsageStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  no_credentials: 'No credentials',
  not_configured: 'Not configured',
};

function usageStatusOf(p: ProviderRow): UsageStatus {
  return p.usageStatus || 'active';
}

function isInactiveBucket(status: UsageStatus): boolean {
  return status === 'inactive' || status === 'no_credentials' || status === 'not_configured';
}

function statusBadgeClass(status: UsageStatus): string {
  switch (status) {
    case 'active':
      return 'text-emerald-400';
    case 'inactive':
      return 'text-slate-400';
    case 'no_credentials':
      return 'text-amber-400';
    case 'not_configured':
      return 'text-slate-500';
    default:
      return 'text-slate-400';
  }
}

function healthDotClass(health: string | null | undefined): string {
  if (!health) return 'bg-slate-600';
  if (health === 'Healthy') return 'bg-emerald-500';
  if (health === 'Offline') return 'bg-rose-500';
  return 'bg-amber-500';
}

export default function AIProviderManagement() {
  const [activeSubTab, setActiveSubTab] = useState<'providers' | 'routing' | 'agents' | 'benchmarks' | 'costs' | 'playground'>('providers');
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [usage, setUsage] = useState<any[]>([]);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  // Real bug fix (2026-08-18 UI audit, Phase 5): every dropdown used to POST the UI's display
  // label ("News", "Chief Trader") as the routing key, but every real routeTask()/routeConsensus()
  // call site keys itself by a different internal agentType string ('NewsAgent', 'ConsensusDebate',
  // ...) - grepped across src/server for every real call site. The DB write always succeeded, but
  // AIRouter's exact-string lookup meant every override silently had zero effect. Labels with no
  // real caller anywhere (Technical, Risk, Options, Portfolio, Execution, Compliance, Performance,
  // Cost Optimizer, Router, Memory) are removed rather than shown as if they could be routed.
  const AGENT_ROUTING_KEYS: Record<string, string> = {
    'News': 'NewsAgent',
    'Fundamental': 'FundamentalAgent',
    'Macro': 'MacroAgent',
    'Chief Trader (Consensus Debate)': 'ConsensusDebate',
    'Reflection': 'ReflectionEngine',
    'Market Regime': 'MarketRegimeAgent',
    'Explainability': 'ExplainabilityAgent',
    'Quant Contradiction Analyzer': 'QuantContradictionAnalyzer',
    'General (fallback/legacy)': 'General',
  };
  const [routingOverrides, setRoutingOverrides] = useState<Record<string, string>>({});
  const [routingSaveState, setRoutingSaveState] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});
  const [routingSaveError, setRoutingSaveError] = useState<Record<string, string>>({});

  const fetchRoutingOverrides = () => {
    fetch('/api/v1/config/routing')
      .then(res => res.json())
      .then(data => {
        if (!Array.isArray(data)) return;
        const next: Record<string, string> = {};
        for (const row of data) {
          if (row?.agentName && row?.providerId) next[row.agentName] = row.providerId;
        }
        setRoutingOverrides(next);
      })
      .catch(() => { /* leave dropdowns at Auto-Select if this fails - not a fabricated state */ });
  };

  const saveAgentRoute = async (agentKey: string, providerId: string) => {
    setRoutingSaveState(prev => ({ ...prev, [agentKey]: 'saving' }));
    try {
      const res = await fetch('/api/v1/config/routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agentKey, providerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setRoutingSaveState(prev => ({ ...prev, [agentKey]: 'error' }));
        setRoutingSaveError(prev => ({ ...prev, [agentKey]: data?.error || `Save failed (${res.status})` }));
        return;
      }
      setRoutingOverrides(prev => ({ ...prev, [agentKey]: providerId }));
      setRoutingSaveState(prev => ({ ...prev, [agentKey]: 'saved' }));
      setTimeout(() => setRoutingSaveState(prev => ({ ...prev, [agentKey]: undefined as any })), 2500);
    } catch (e: any) {
      setRoutingSaveState(prev => ({ ...prev, [agentKey]: 'error' }));
      setRoutingSaveError(prev => ({ ...prev, [agentKey]: e?.message || 'Failed to reach the server.' }));
    }
  };

  useEffect(() => {
    fetch('/api/v1/config/providers')
      .then(res => res.json())
      .then(data => setProviders(Array.isArray(data) ? data : []));

    fetch('/api/v1/config/usage')
      .then(res => res.json())
      .then(data => setUsage(Array.isArray(data) ? data : []));

    fetchRoutingOverrides();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onmessage = (event) => {
        try {
            // server.ts wraps every EventBus event as {type: eventName, data: payload}.
            // AIRouter publishes ai_metrics_update via eventBus.publish('UI_UPDATE', {type, payload}),
            // so the real shape here is {type: 'UI_UPDATE', data: {type: 'ai_metrics_update', payload}}.
            const data = JSON.parse(event.data);
            if (data.type === 'UI_UPDATE' && data.data?.type === 'ai_metrics_update') {
                setUsage(prev => [data.data.payload, ...prev].slice(0, 100));
            }
        } catch(e) {}
    };
    return () => ws.close();
  }, []);

  const totalTokens = usage.reduce((acc, curr) => acc + (curr.completionTokens || curr.tokens || 0), 0);
  const totalCost = usage.reduce((acc, curr) => acc + (curr.cost || 0), 0);
  const successCount = usage.filter(u => u.success !== false && (!u.responseStatus || !u.responseStatus.includes('error'))).length;
  const callSuccessRate = usage.length > 0 ? Math.round((successCount / usage.length) * 100) : null;

  const activeProviders = useMemo(
    () => providers.filter(p => usageStatusOf(p) === 'active'),
    [providers],
  );
  const inactiveProviders = useMemo(
    () => providers.filter(p => isInactiveBucket(usageStatusOf(p))),
    [providers],
  );

  const filteredProviders = useMemo(() => {
    if (providerFilter === 'active') return activeProviders;
    if (providerFilter === 'inactive') return inactiveProviders;
    return providers;
  }, [providerFilter, providers, activeProviders, inactiveProviders]);

  const routableProviders = activeProviders.filter(p => p.inDatabase !== false);

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
                <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
                  DB rows plus known catalog providers — including not configured / no key / disabled.
                </p>
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
                 <div className="bg-[#0A0F16] border border-slate-800 p-4 rounded-lg flex flex-col" title="Enabled providers with credentials (or local endpoints) that AIRouter can load.">
                   <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Active Providers</div>
                   <div className="text-2xl font-bold text-indigo-400">{activeProviders.length}</div>
                   <div className="text-[10px] text-slate-600 mt-1">
                     {inactiveProviders.length} not in use · {providers.length} total
                   </div>
                 </div>
                 <div className="bg-[#0A0F16] border border-slate-800 p-4 rounded-lg flex flex-col">
                   <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Total Tokens</div>
                   <div className="text-2xl font-bold text-emerald-400">{totalTokens.toLocaleString()}</div>
                 </div>
                 <div
                   className="bg-[#0A0F16] border border-slate-800 p-4 rounded-lg flex flex-col"
                   title="Share of ai_usage rows that succeeded — not a live probe of every provider card."
                 >
                   <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Call Success Rate</div>
                   <div className="text-2xl font-bold text-sky-400">
                     {callSuccessRate === null ? (
                       <UnavailableHint reason="No ai_usage rows yet — this is not a live network probe of every provider.">
                         --
                       </UnavailableHint>
                     ) : (
                       `${callSuccessRate}%`
                     )}
                   </div>
                   <div className="text-[10px] text-slate-600 mt-1">From recorded AIRouter calls</div>
                 </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span className="text-[10px] text-slate-500 uppercase tracking-widest mr-1">Show</span>
              {([
                { id: 'all', label: `All (${providers.length})` },
                { id: 'active', label: `Active (${activeProviders.length})` },
                { id: 'inactive', label: `Not in use (${inactiveProviders.length})` },
              ] as const).map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setProviderFilter(opt.id)}
                  className={`px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-widest border transition-colors ${
                    providerFilter === opt.id
                      ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-300'
                      : 'bg-[#0A0F16] border-slate-800 text-slate-500 hover:border-slate-600'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] text-slate-500 uppercase tracking-widest">
                    <th className="pb-3 font-medium">Provider</th>
                    <th className="pb-3 font-medium">Endpoint</th>
                    <th className="pb-3 font-medium">Avg Latency</th>
                    <th className="pb-3 font-medium">Success</th>
                    <th className="pb-3 font-medium">Health</th>
                    <th className="pb-3 font-medium">Usage</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProviders.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-xs text-slate-500">
                        No providers in this filter.
                      </td>
                    </tr>
                  ) : filteredProviders.map(p => {
                    const status = usageStatusOf(p);
                    const metricsOk = !!p.metricsAvailable;
                    const health = p.displayHealth ?? (metricsOk ? p.health : null);
                    return (
                  <tr key={p.id} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                    <td className="py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${healthDotClass(health)}`} title={p.healthNote || undefined}></div>
                        <div>
                          <div className="text-xs font-bold text-slate-300">{p.providerName}</div>
                          <div className="text-[10px] text-slate-500 uppercase tracking-widest">
                            {p.inDatabase === false
                              ? 'Catalog only'
                              : `Priority ${p.priority ?? '—'}`}
                            {p.hasCredentials
                              ? ` · Key (${p.credentialSource || 'set'})`
                              : p.isLocal
                                ? ' · Local (no key required)'
                                : ' · No key'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 text-xs text-slate-400">{p.apiEndpoint || 'SDK Default'}</td>
                    <td className="py-4 text-xs font-mono text-amber-400">
                      {p.latencyAvailable ? (
                        `${Math.round(p.latency || 0)}ms`
                      ) : (
                        <UnavailableHint reason={p.healthNote || 'No successful call has updated latency yet — 0ms would be a default, not a measurement.'}>
                          --
                        </UnavailableHint>
                      )}
                    </td>
                    <td className="py-4 text-xs text-slate-400">
                      {metricsOk ? (
                        `${Math.round(p.successRate ?? 0)}%`
                      ) : (
                        <UnavailableHint reason={p.healthNote || 'Success rate is only meaningful after AIRouter has called this provider.'}>
                          --
                        </UnavailableHint>
                      )}
                    </td>
                    <td className="py-4 text-xs font-bold" title={p.healthNote || undefined}>
                      {health ? (
                        <span className={health === 'Healthy' ? 'text-emerald-400' : health === 'Offline' ? 'text-rose-400' : 'text-amber-400'}>
                          {health}
                        </span>
                      ) : (
                        <UnavailableHint reason={p.healthNote || 'Health is updated from real AIRouter calls, not a background ping.'}>
                          --
                        </UnavailableHint>
                      )}
                    </td>
                    <td className={`py-4 text-xs font-bold ${statusBadgeClass(status)}`} title={p.healthNote || undefined}>
                      {USAGE_STATUS_LABEL[status]}
                    </td>
                  </tr>
                    );
                  })}
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
                  {Object.entries(AGENT_ROUTING_KEYS).map(([label, agentKey]) => {
                    const saveState = routingSaveState[agentKey];
                    return (
                      <div key={agentKey} className="bg-[#0A0F16] border border-slate-800 p-4 rounded-lg flex flex-col gap-2">
                          <div className="flex justify-between items-center gap-3">
                            <div className="text-xs font-bold text-slate-300">{label}</div>
                            <div className="flex items-center gap-2">
                              {saveState === 'saving' && <span className="text-[9px] text-slate-500 uppercase tracking-widest">Saving...</span>}
                              {saveState === 'saved' && <span className="text-[9px] text-emerald-400 uppercase tracking-widest flex items-center gap-1"><CheckCircle2 size={10}/> Saved</span>}
                              {saveState === 'error' && <span className="text-[9px] text-rose-400 uppercase tracking-widest flex items-center gap-1"><XCircle size={10}/> Failed</span>}
                              <select
                                className="bg-[#111822] border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 outline-none"
                                value={routingOverrides[agentKey] || 'auto'}
                                onChange={(e) => { void saveAgentRoute(agentKey, e.target.value); }}
                              >
                                 <option value="auto">Auto-Select (Best Available)</option>
                                 {routableProviders.map(p => (
                                    <option key={p.id} value={p.id}>{p.providerName}</option>
                                 ))}
                              </select>
                            </div>
                          </div>
                          {saveState === 'error' && routingSaveError[agentKey] && (
                            <p className="text-[10px] text-rose-400">{routingSaveError[agentKey]}</p>
                          )}
                      </div>
                    );
                  })}
              </div>
              <p className="text-[9px] text-slate-600 mt-4 leading-relaxed">
                Only agents that actually call AIRouter are listed - TechnicalAgent, RiskAgent, and several other display names in earlier versions of this table never called an LLM at all, so routing them had no effect regardless of what was selected.
              </p>
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
                  {usage.map((u, i) => (
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
