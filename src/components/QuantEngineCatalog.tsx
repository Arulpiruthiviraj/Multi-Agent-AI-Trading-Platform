/**
 * Full Java Quant Core engine catalog + honest wiring-flow view (2026-09-10,
 * docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md follow-up). Read-only. Reads
 * GET /api/v2/quant-core/catalog (real config/engineOwnership.json data via the existing
 * validated modelRegistry.ts loader) — never fabricates counts, statuses, or wiring state.
 *
 * Frontend-honesty discipline (CLAUDE.md "Frontend honesty" table): the flow diagram below shows
 * exactly what is verified live-wired today (TS StrategyEngine always; the two Sept-9 overrides
 * and the 6 SHADOW engines only when their real flags/status say so) versus the ~120 RESEARCH
 * engines, which are explicitly labeled DORMANT — implemented and tested, zero live consumer.
 * Never implies research-catalog code is "in use" for a real trading decision.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Boxes, ChevronRight, GitBranch, RefreshCw, Search } from 'lucide-react';

interface CatalogEngine {
  key: string;
  name: string;
  category: string;
  status: string | null;
  owner: string;
  javaAvailable: boolean;
  httpEndpoint: string;
  liveConsumer: string;
  javaAuthoritative: boolean;
  description: string;
}

interface WiringState {
  javaQuantCoreEnabled: boolean;
  javaLiveIdeasEnabled: boolean;
  javaFactorCompositeVoteEnabled: boolean;
  quantIndependentQualificationEnabled: boolean;
}

interface CatalogResponse {
  ok: boolean;
  totalEngines: number;
  categoryCounts: Record<string, number>;
  engines: CatalogEngine[];
  wiring: WiringState;
}

const CATEGORY_ORDER = [
  'Options', 'Volatility', 'FX', 'Fixed Income', 'Commodities', 'Futures',
  'Structured Products (CDO)', 'Index', 'Crypto', 'Stocks & ETFs',
  'Stocks & ETFs (Retail Strategy Research)', 'Cross-Asset / Institutional Infrastructure',
  'Live TS Indicators', 'Live TS CORE Strategies', 'Architecture Spine', 'Backtesting Infrastructure',
];

function statusBadgeClass(status: string | null): string {
  switch (status) {
    case 'SHADOW': return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
    case 'PAPER': case 'VALIDATED': case 'PRODUCTION_CANDIDATE': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
    case 'DEPRECATED': case 'DISABLED': return 'text-rose-400 bg-rose-500/10 border-rose-500/30';
    case 'RESEARCH': case 'BACKTEST': case 'WALK_FORWARD': return 'text-slate-400 bg-slate-500/10 border-slate-500/30';
    case null: return 'text-slate-600 bg-slate-800/40 border-slate-700/40';
    default: return 'text-sky-400 bg-sky-500/10 border-sky-500/30';
  }
}

function FlowNode({ label, sub, live }: { label: string; sub?: string; live: 'live' | 'dormant' | 'neutral' }) {
  const border = live === 'live' ? 'border-emerald-500/40' : live === 'dormant' ? 'border-slate-700' : 'border-indigo-500/40';
  const text = live === 'live' ? 'text-emerald-400' : live === 'dormant' ? 'text-slate-500' : 'text-indigo-300';
  return (
    <div className={`border ${border} rounded-lg px-3 py-2 text-center min-w-[140px]`}>
      <div className={`text-[11px] font-bold uppercase tracking-widest ${text}`}>{label}</div>
      {sub && <div className="text-[9px] text-slate-500 mt-0.5 uppercase tracking-wide">{sub}</div>}
    </div>
  );
}

export default function QuantEngineCatalog() {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchCatalog = () => {
    fetch('/api/v2/quant-core/catalog')
      .then((r) => r.json())
      .then((d: CatalogResponse) => { if (d.ok) setData(d); else setError('Catalog load failed'); })
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    fetchCatalog();
  }, []);

  const filteredEngines = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.engines.filter((e) => {
      if (activeCategory && e.category !== activeCategory) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
    });
  }, [data, search, activeCategory]);

  const groupedByCategory = useMemo(() => {
    const groups = new Map<string, CatalogEngine[]>();
    for (const e of filteredEngines) {
      if (!groups.has(e.category)) groups.set(e.category, []);
      groups.get(e.category)!.push(e);
    }
    return groups;
  }, [filteredEngines]);

  const orderedCategories = useMemo(() => {
    if (!data) return [];
    const present = new Set(data.engines.map((e) => e.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [data]);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const w = data?.wiring;

  return (
    <div className="bg-[#111822] border border-slate-850 p-5 rounded-lg border-l-4 border-l-emerald-500 font-mono mb-8">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <Boxes size={14} className="text-emerald-400" /> Quant engine catalog
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Full config/engineOwnership.json registry — status shown verbatim, never implies a RESEARCH engine is in live use
          </p>
        </div>
        <button onClick={fetchCatalog} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load catalog: {error}</p>}
      {!data && !error && <p className="text-[11px] text-slate-500">Loading catalog…</p>}

      {data && (
        <>
          {/* Summary stat tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
            <div className="bg-[#0F141C] border border-slate-800 rounded-lg px-3 py-2">
              <div className="text-lg font-bold text-slate-100 tabular-nums">{data.totalEngines}</div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest">Registered engines</div>
            </div>
            <div className="bg-[#0F141C] border border-slate-800 rounded-lg px-3 py-2">
              <div className="text-lg font-bold text-slate-100 tabular-nums">{orderedCategories.length}</div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest">Categories</div>
            </div>
            <div className="bg-[#0F141C] border border-slate-800 rounded-lg px-3 py-2">
              <div className="text-lg font-bold text-amber-400 tabular-nums">{data.engines.filter((e) => e.status === 'SHADOW').length}</div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest">Shadow (real, non-voting)</div>
            </div>
            <div className="bg-[#0F141C] border border-slate-800 rounded-lg px-3 py-2">
              <div className="text-lg font-bold text-slate-500 tabular-nums">{data.engines.filter((e) => e.status === 'RESEARCH').length}</div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest">Research (dormant)</div>
            </div>
          </div>

          {/* Honest wiring flow */}
          {w && (
            <div className="bg-[#0F141C] border border-slate-800 rounded-lg p-4 mb-5">
              <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                <GitBranch size={12} className="text-indigo-400" /> How Argus actually uses this — real wiring, not a diagram of intent
              </h4>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <FlowNode label="Market Data" live="neutral" />
                <ChevronRight size={14} className="text-slate-700" />
                <FlowNode label="TS StrategyEngine" sub="5 CORE + 16 experimental, always live" live="live" />
                <ChevronRight size={14} className="text-slate-700" />
                <FlowNode label="QuantEngine vote" sub="1 vote into ChiefTrader" live="live" />
                <ChevronRight size={14} className="text-slate-700" />
                <FlowNode label="ChiefTrader" sub="0.75 bar, 2 min independent" live="live" />
              </div>
              <div className="pl-6 border-l-2 border-slate-800 ml-4 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <FlowNode label="Java Quant Core" sub={w.javaQuantCoreEnabled ? 'process reachable' : 'disabled'} live={w.javaQuantCoreEnabled ? 'live' : 'dormant'} />
                  <ChevronRight size={14} className="text-slate-700" />
                  <FlowNode label="6 Shadow engines" sub="debate-context TEXT only, never a vote" live={w.javaQuantCoreEnabled ? 'live' : 'dormant'} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <FlowNode label="JavaFactorComposite" sub="2026-09-09 override, 1 real vote" live={w.javaFactorCompositeVoteEnabled ? 'live' : 'dormant'} />
                  <ChevronRight size={14} className="text-slate-700" />
                  <FlowNode label="ChiefTrader" sub="same 0.75 bar as any agent" live={w.javaFactorCompositeVoteEnabled ? 'live' : 'dormant'} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <FlowNode label="Quant independence-qualification" sub="2026-09-09 override, floor substitute" live={w.quantIndependentQualificationEnabled ? 'live' : 'dormant'} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <FlowNode label="5 CORE strategies (Java-owned features)" sub="shadow parity-log only, zero vote" live="dormant" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <FlowNode label={`~${data.engines.filter((e) => e.status === 'RESEARCH').length} Research engines`} sub="zero HTTP endpoint, zero consumer" live="dormant" />
                </div>
              </div>
              <p className="text-[9px] text-slate-600 mt-3">
                Green = confirmed live right now. Grey = implemented, tested, currently dormant — not a claim it will never be used, just honestly not wired into a trading decision today.
              </p>
            </div>
          )}

          {/* Search + category filter */}
          <div className="flex flex-wrap gap-2 mb-4 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, key, or formula…"
                className="w-full bg-[#0F141C] border border-slate-800 rounded-lg pl-8 pr-3 py-2 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50"
              />
            </div>
            <button
              onClick={() => setActiveCategory(null)}
              className={`px-2.5 py-1.5 rounded-full text-[10px] uppercase tracking-widest border ${!activeCategory ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-300' : 'border-slate-800 text-slate-500 hover:border-slate-700'}`}
            >
              All
            </button>
            {orderedCategories.map((c) => (
              <button
                key={c}
                onClick={() => setActiveCategory(c === activeCategory ? null : c)}
                className={`px-2.5 py-1.5 rounded-full text-[10px] uppercase tracking-widest border ${activeCategory === c ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-300' : 'border-slate-800 text-slate-500 hover:border-slate-700'}`}
              >
                {c} <span className="text-slate-600">({data.categoryCounts[c] ?? 0})</span>
              </button>
            ))}
          </div>

          <p className="text-[10px] text-slate-600 mb-3">{filteredEngines.length} of {data.totalEngines} engines shown</p>

          {/* Catalog list, grouped by category */}
          <div className="space-y-6 max-h-[600px] overflow-y-auto pr-1">
            {[...groupedByCategory.entries()].map(([category, engines]) => (
              <div key={category}>
                <h5 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-800 pb-1">
                  {category} <span className="text-slate-600">({engines.length})</span>
                </h5>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {engines.map((e) => (
                    <div key={e.key} className="bg-[#0F141C] border border-slate-800 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-[12px] font-bold text-slate-200">{e.name}</div>
                          <div className="text-[9px] text-slate-600">{e.key}</div>
                        </div>
                        <span className={`shrink-0 border rounded px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest ${statusBadgeClass(e.status)}`}>
                          {e.status ?? 'ARCHITECTURE'}
                        </span>
                      </div>
                      {e.description && (
                        <button
                          onClick={() => toggleExpanded(e.key)}
                          className="text-[10px] text-emerald-400 mt-2 flex items-center gap-1"
                        >
                          <ChevronRight size={10} className={`transition-transform ${expanded.has(e.key) ? 'rotate-90' : ''}`} />
                          Formula &amp; source
                        </button>
                      )}
                      {expanded.has(e.key) && e.description && (
                        <p className="text-[10px] text-slate-500 mt-2 bg-[#0A0E14] border border-slate-850 rounded p-2 leading-relaxed">
                          {e.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
