import React, { useEffect, useState } from "react";
import { Newspaper, Globe, AlertTriangle, TrendingUp, TrendingDown, Activity, Clock, ShieldCheck, Database, Server, Crosshair } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, BarChart, Bar, Cell } from "recharts";

export function NewsDashboardTab() {
  const [clusters, setClusters] = useState<any[]>([]);
  const [articles, setArticles] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchNewsData = async () => {
      try {
        const [clustersRes, articlesRes, providersRes] = await Promise.all([
          fetch("/api/v1/news/timeline"),
          fetch("/api/v1/news/articles"),
          fetch("/api/v1/news/providers")
        ]);
        
        if (clustersRes.ok) setClusters(await clustersRes.json());
        if (articlesRes.ok) setArticles(await articlesRes.json());
        if (providersRes.ok) setProviders(await providersRes.json());
      } catch (err) {
        console.error("Failed to fetch news intelligence data", err);
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchNewsData();
    const interval = setInterval(fetchNewsData, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="animate-fade-in flex flex-col gap-6">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2 uppercase tracking-wide">
            <Globe size={16} className="text-blue-400" />
            Global News Intelligence Engine
          </h3>
          <p className="text-[11px] text-slate-400 max-w-3xl leading-relaxed">
            Continuously ingesting, normalizing, deduplicating, and analyzing global market events from multiple trusted providers.
            Provides consensus intelligence and correlation mappings directly to the Chief Trader.
          </p>
        </div>
        <div className="flex gap-2">
           <div className="bg-[#111822] border border-slate-800 px-3 py-1.5 rounded-lg flex items-center gap-2">
             <Server size={12} className="text-slate-500" />
             <span className="text-[10px] font-mono text-slate-300">Active Sources: {providers.filter(p => p.enabled).length}/{providers.length}</span>
           </div>
           <div className="bg-[#111822] border border-slate-800 px-3 py-1.5 rounded-lg flex items-center gap-2">
             <Database size={12} className="text-slate-500" />
             <span className="text-[10px] font-mono text-slate-300">Monitored Events: {clusters.length}</span>
           </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Market Event Clusters */}
        <div className="lg:col-span-2 bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex flex-col h-[500px]">
          <h4 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
            <Activity size={14} className="text-indigo-400" /> Market Event Clusters
          </h4>
          <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
            {clusters.length === 0 && !isLoading ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500 font-mono text-xs">
                <Globe size={24} className="mb-2 opacity-50" />
                No active event clusters detected.
              </div>
            ) : (
              clusters.map((cluster, idx) => {
                const sentiment = (cluster.sentimentScore || 0);
                const syms = cluster.symbols ? JSON.parse(cluster.symbols) : [];
                return (
                  <div key={idx} className="bg-[#111822] border border-slate-800/80 p-3 rounded-md hover:border-slate-700 transition-colors">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono ${
                          sentiment > 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 
                          sentiment < 0 ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 
                          'bg-slate-800 text-slate-300 border border-slate-700'
                        }`}>
                          {sentiment > 0 ? 'BULLISH' : sentiment < 0 ? 'BEARISH' : 'NEUTRAL'} {sentiment.toFixed(2)}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[9px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono">
                          {cluster.eventType || 'Macro'}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-slate-500 flex items-center gap-1">
                        <Clock size={10} /> {new Date(cluster.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <h5 className="text-sm font-semibold text-slate-200 mb-1 leading-snug">{cluster.title}</h5>
                    <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed mb-3">{cluster.summary}</p>
                    <div className="flex flex-wrap items-center gap-4 border-t border-slate-800/60 pt-2 mt-2">
                       <div className="flex items-center gap-1.5">
                         <span className="text-[9px] font-mono text-slate-500 uppercase">Impact:</span>
                         <span className="text-[10px] font-mono text-slate-300">{cluster.impactScore?.toFixed(2) || 'N/A'}</span>
                       </div>
                       <div className="flex items-center gap-1.5">
                         <span className="text-[9px] font-mono text-slate-500 uppercase">Horizon:</span>
                         <span className="text-[10px] font-mono text-slate-300">{cluster.timeHorizon || 'Unknown'}</span>
                       </div>
                       <div className="flex gap-1 ml-auto">
                        {syms.map((sym: string) => (
                          <span key={sym} className="px-1.5 py-0.5 rounded text-[9px] bg-slate-800 text-slate-300 font-mono border border-slate-700">
                            {sym}
                          </span>
                        ))}
                       </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Breaking News Feed */}
        <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex flex-col h-[500px]">
          <h4 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
            <Newspaper size={14} className="text-sky-400" /> Breaking News Feed
          </h4>
          <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
            {articles.length === 0 && !isLoading ? (
               <div className="text-center text-slate-500 text-xs mt-10 font-mono">No breaking news ingested yet.</div>
            ) : (
              articles.map((article, idx) => (
                <div key={idx} className="bg-[#111822] border-l-2 border-l-sky-500/50 pl-3 py-2 pr-2">
                   <div className="flex justify-between items-center mb-1">
                     <span className="text-[9px] font-mono text-sky-400 font-bold">{article.source}</span>
                     <span className="text-[9px] font-mono text-slate-500">{new Date(article.publishedAt).toLocaleTimeString()}</span>
                   </div>
                   <p className="text-[11px] text-slate-200 leading-snug">{article.title}</p>
                   <div className="flex justify-between items-center mt-2">
                     <span className="text-[9px] font-mono text-slate-500 flex items-center gap-1">
                        <ShieldCheck size={9} /> Cred: {(article.credibilityScore || 0).toFixed(2)}
                     </span>
                     {article.symbols && (
                       <span className="text-[9px] font-mono text-indigo-400">
                         {JSON.parse(article.symbols).join(', ')}
                       </span>
                     )}
                   </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      
      {/* Source Health & Analytics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Provider Statistics */}
        <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4">
          <h4 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-slate-800 pb-2">
            <Server size={14} className="text-emerald-400" /> Source Health & Provider Statistics
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] uppercase font-mono text-slate-500">
                  <th className="py-2 px-2 font-normal">Provider</th>
                  <th className="py-2 px-2 font-normal">Status</th>
                  <th className="py-2 px-2 font-normal text-right">Errors</th>
                  <th className="py-2 px-2 font-normal text-right">Credibility</th>
                  <th className="py-2 px-2 font-normal text-right">Last Sync</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider, idx) => (
                  <tr key={idx} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                    <td className="py-2.5 px-2 text-[11px] text-slate-200">{provider.name}</td>
                    <td className="py-2.5 px-2">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${
                        provider.health === 'Healthy' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                      }`}>
                        {provider.health}
                      </span>
                    </td>
                    <td className="py-2.5 px-2 text-[11px] font-mono text-slate-400 text-right">{provider.errorCount}</td>
                    <td className="py-2.5 px-2 text-[11px] font-mono text-slate-400 text-right">{provider.credibilityWeight?.toFixed(2)}</td>
                    <td className="py-2.5 px-2 text-[10px] font-mono text-slate-500 text-right">{provider.lastFetch ? new Date(provider.lastFetch).toLocaleTimeString() : 'Never'}</td>
                  </tr>
                ))}
                {providers.length === 0 && (
                   <tr>
                     <td colSpan={5} className="py-4 text-center text-xs text-slate-500 font-mono">No providers registered</td>
                   </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* High-Impact News Veto - real data (cluster.impactScore, already fetched above) describing
            RiskEngine's actual news_veto gate, not the fabricated "Chief Trader reads embeddings"
            claim this card used to make (no embeddings/vector infrastructure exists in this
            codebase at all - ChiefTraderAgent never sees impactScore in any form). */}
        <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex flex-col justify-center items-center">
             <Crosshair size={32} className="text-slate-700 mb-3" />
             <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">
               {clusters.filter(c => (c.impactScore ?? 0) > 80).length} High-Impact Event{clusters.filter(c => (c.impactScore ?? 0) > 80).length === 1 ? '' : 's'} Tracked
             </h4>
             <p className="text-[10px] text-slate-500 font-mono text-center max-w-xs">
               RiskEngine vetoes new trades on a symbol with a tracked event cluster scoring above 80
               within the last 4 hours. This score does not otherwise influence Chief Trader's consensus.
             </p>
        </div>
      </div>
    </div>
  );
}
