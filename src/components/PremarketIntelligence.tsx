/**
 * Session-Aware Trading Architecture mission §18/§27 follow-up (2026-09-05,
 * docs/audits/ARGUS_PREMARKET_TRADING_IMPLEMENTATION.md). Read-only surface over already-existing,
 * already-tested REST endpoints (continuousIntelRouter's /trade-plans, /ranking/latest,
 * /missed-opportunities; v2Runtime's /session-lifecycle) - no new backend query logic lives here.
 *
 * Honesty: this view itself never exposes an "execute" or "override" control, matching every
 * other discovery/intel surface in this codebase (RiskGateHistoryPanel.tsx's "no bypass control
 * exists here" convention) - nothing on this PAGE can trigger a trade. As of 2026-09-05 (explicit
 * operator authorization, docs/audits/ARGUS_PREMARKET_TRADING_IMPLEMENTATION.md §12), a
 * PRIMARY-tier plan listed here DOES reach TRADE_IDEA_GENERATED as one independent ChiefTrader
 * vote (TradePlanBuilder.emitTradePlanIdea()) when ARGUS_TRADE_PLAN_IDEAS_ENABLED is on - so a
 * plan's STATUS badge below can change as a real consequence of ChiefTrader/RiskEngine/OMS
 * processing it, same as any other agent's idea. See §12 for the full gating detail.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Sunrise, Clock, ListChecks, Target, AlertTriangle, RefreshCw } from 'lucide-react';
import AwaitingSignal from './shared/AwaitingSignal';

interface SessionLifecycleSnapshot {
  marketSession: 'PRE_MARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED';
  appState: string;
  tradingDate: string;
  evaluatedAt: string;
  sessionId: string;
  isExtendedHours: boolean;
  isTradingDay: boolean;
  minutesToOpen: number | null;
  minutesSinceOpen: number | null;
  minutesToClose: number | null;
}

interface TradePlan {
  id: string;
  symbol: string;
  planDate: string;
  setupType: 'PRIMARY' | 'BACKUP' | 'WATCHLIST';
  direction: 'BUY' | 'SELL';
  thesis: string;
  catalysts: string[];
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  invalidationLevel: number | null;
  confidence: number;
  confluenceScore: number;
  catalystType: string | null;
  catalystSourceCount: number | null;
  status: string;
  rankAtCreation: number;
  validUntil: string;
}

interface RankedCandidate {
  symbol: string;
  rank: number;
  rankDelta: number | null;
  finalScore: number;
  promotionRecommendation: 'PROMOTE' | 'HOLD' | 'REJECT';
  promotionReason: string;
}

interface MissedOpportunityRow {
  symbol: string;
  classification: string;
  classificationReason: string;
  detectedAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'text-slate-500 bg-slate-800/50',
  READY: 'text-cyan-400 bg-cyan-900/30',
  REVALIDATING: 'text-amber-400 bg-amber-900/30',
  VALID: 'text-emerald-400 bg-emerald-900/30',
  INVALIDATED: 'text-rose-400 bg-rose-900/30',
  EXPIRED: 'text-slate-500 bg-slate-800/50',
  EXECUTED: 'text-purple-400 bg-purple-900/30',
  CLOSED: 'text-slate-500 bg-slate-800/50',
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtMinutes(m: number | null): string {
  if (m == null) return 'n/a';
  const sign = m >= 0 ? '+' : '';
  return `${sign}${m}m`;
}

interface LiveWiringStatus {
  tradePlanIdeasEnabled: boolean;
  tradePlanBuilderAgentEnabled: boolean;
  extendedHoursExecutionEnabled: boolean;
}

export default function PremarketIntelligence() {
  const [session, setSession] = useState<SessionLifecycleSnapshot | null>(null);
  const [plans, setPlans] = useState<TradePlan[] | null>(null);
  const [ranking, setRanking] = useState<RankedCandidate[] | null>(null);
  const [missed, setMissed] = useState<MissedOpportunityRow[] | null>(null);
  const [liveWiring, setLiveWiring] = useState<LiveWiringStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAll = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);

    fetch('/api/v2/runtime/session-lifecycle', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setSession(d.refined ?? d.current); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });

    fetch(`/api/v2/continuous-intelligence/trade-plans/${todayIso()}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setPlans(d.plans || []); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });

    fetch('/api/v2/continuous-intelligence/ranking/latest?limit=25', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setRanking(d.candidates || []); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });

    fetch('/api/v2/continuous-intelligence/missed-opportunities?sinceMs=86400000', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setMissed(d.rows || []); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });

    // Real, current flag status (2026-09-05, docs/audits/ARGUS_PREMARKET_TRADING_IMPLEMENTATION.md
    // §12) - drives the ARMED/idle badge below. Never assumed from a static claim.
    fetch('/api/v2/continuous-intelligence/status', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setLiveWiring({
            tradePlanIdeasEnabled: !!d.tradePlanIdeasEnabled,
            tradePlanBuilderAgentEnabled: !!d.tradePlanBuilderAgentEnabled,
            extendedHoursExecutionEnabled: !!d.extendedHoursExecutionEnabled,
          });
        }
      })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, []);

  return (
    <div className="animate-fade-in flex flex-col gap-6" id="premarket-view">
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex justify-between items-center bg-slate-800/50">
          <h3 className="text-sm font-bold text-white uppercase tracking-wide flex items-center gap-2">
            <Sunrise size={16} className="text-cyan-400" />
            Premarket Intelligence
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono bg-cyan-900/50 text-cyan-400 px-2 py-1 rounded">
              THIS PAGE IS READ-ONLY — NO EXECUTE/OVERRIDE CONTROL HERE
            </span>
            {liveWiring?.tradePlanIdeasEnabled && liveWiring?.tradePlanBuilderAgentEnabled ? (
              <span
                className="text-[10px] font-mono bg-rose-900/50 text-rose-400 px-2 py-1 rounded font-bold"
                title="PRIMARY-tier plans below emit a real TRADE_IDEA_GENERATED vote into ChiefTrader (config/pipelineAgents.json 'TradePlanBuilder' + ARGUS_TRADE_PLAN_IDEAS_ENABLED). Still subject to the same 25 RiskEngine gates and 0.75 consensus bar as every other agent."
              >
                LIVE PREMARKET IDEAS: ARMED{liveWiring.extendedHoursExecutionEnabled ? ' + EXTENDED-HOURS EXECUTION' : ''}
              </span>
            ) : (
              <span className="text-[10px] font-mono bg-slate-800 text-slate-500 px-2 py-1 rounded" title="ARGUS_TRADE_PLAN_IDEAS_ENABLED or the TradePlanBuilder Mission Control toggle is off - no TradePlan reaches TRADE_IDEA_GENERATED.">
                LIVE PREMARKET IDEAS: OFF
              </span>
            )}
            <button onClick={fetchAll} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-400 text-[10px] uppercase tracking-widest font-bold rounded">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>

        {error && <p className="text-[11px] text-rose-400 p-4">Could not load premarket intelligence: {error}</p>}

        {session && (
          <div className="p-5 border-b border-slate-800/50 flex flex-wrap gap-6 text-[11px] font-mono">
            <div>
              <div className="text-slate-500 uppercase tracking-widest text-[9px] mb-1">Market Session</div>
              <div className="text-white font-bold">{session.marketSession}</div>
            </div>
            <div>
              <div className="text-slate-500 uppercase tracking-widest text-[9px] mb-1">App State</div>
              <div className="text-cyan-400 font-bold">{session.appState}</div>
            </div>
            <div>
              <div className="text-slate-500 uppercase tracking-widest text-[9px] mb-1">Trading Date</div>
              <div className="text-slate-300">{session.tradingDate}</div>
            </div>
            <div className="flex items-center gap-1 text-slate-400">
              <Clock size={12} />
              <span>To open {fmtMinutes(session.minutesToOpen)}</span>
              <span className="text-slate-600">·</span>
              <span>Since open {fmtMinutes(session.minutesSinceOpen)}</span>
              <span className="text-slate-600">·</span>
              <span>To close {fmtMinutes(session.minutesToClose)}</span>
            </div>
          </div>
        )}

        <div className="px-5 py-3 border-b border-slate-800/50 flex items-center gap-2 text-[10px] font-mono text-slate-500 uppercase tracking-widest">
          <ListChecks size={12} className="text-cyan-400" /> Today's TradePlans (hypotheses, never orders)
        </div>
        {plans === null ? (
          <div className="py-8 text-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">Loading trade plans...</div>
        ) : plans.length === 0 ? (
          <div className="p-6">
            <AwaitingSignal
              label="TradePlans"
              emptyResult
              reason="No real TradePlan exists for today yet - built once per trading day at PRE_MARKET from a real ComposableRanking cycle (never fabricated)."
            />
          </div>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {plans.map((p) => (
              <div key={p.id} className="p-4 hover:bg-slate-800/20 transition-colors">
                <div className="flex flex-wrap justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-white">{p.symbol}</span>
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded uppercase ${p.direction === 'BUY' ? 'text-emerald-400 bg-emerald-900/30' : 'text-rose-400 bg-rose-900/30'}`}>{p.direction}</span>
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase text-slate-400 bg-slate-800">{p.setupType}</span>
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded uppercase ${STATUS_COLORS[p.status] || 'text-slate-400 bg-slate-800'}`}>{p.status}</span>
                  </div>
                  <div className="flex gap-4 font-mono text-[10px] text-slate-400">
                    <span>Confidence <span className="text-white">{(p.confidence * 100).toFixed(0)}%</span></span>
                    <span>Confluence <span className="text-white">{(p.confluenceScore * 100).toFixed(0)}%</span></span>
                    <span>Rank #{p.rankAtCreation}</span>
                  </div>
                </div>
                <p className="text-[11px] text-slate-300 font-mono mb-2">{p.thesis}</p>
                <div className="flex flex-wrap gap-4 text-[10px] font-mono text-slate-500">
                  {p.entryZoneLow != null && p.entryZoneHigh != null && (
                    <span>Entry zone {p.entryZoneLow.toFixed(2)}–{p.entryZoneHigh.toFixed(2)}</span>
                  )}
                  {p.invalidationLevel != null && <span>Invalidation {p.invalidationLevel.toFixed(2)}</span>}
                  {p.catalystType && <span>Catalyst {p.catalystType} ({p.catalystSourceCount ?? 0} sources)</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800/50 flex items-center gap-2 text-[10px] font-mono text-slate-500 uppercase tracking-widest">
          <Target size={12} className="text-cyan-400" /> Latest Candidate Ranking (ComposableRanking, real 8-component score)
        </div>
        {ranking === null ? (
          <div className="py-8 text-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">Loading ranking...</div>
        ) : ranking.length === 0 ? (
          <div className="p-6">
            <AwaitingSignal label="Candidate Ranking" emptyResult reason="No ranking cycle has persisted yet this session." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-slate-500 uppercase tracking-widest text-[9px] border-b border-slate-800">
                  <th className="text-left px-4 py-2">Rank</th>
                  <th className="text-left px-4 py-2">Symbol</th>
                  <th className="text-left px-4 py-2">Score</th>
                  <th className="text-left px-4 py-2">Δ</th>
                  <th className="text-left px-4 py-2">Recommendation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {ranking.map((r) => (
                  <tr key={r.symbol} className="hover:bg-slate-800/20">
                    <td className="px-4 py-2 text-slate-400">#{r.rank}</td>
                    <td className="px-4 py-2 text-white font-bold">{r.symbol}</td>
                    <td className="px-4 py-2 text-slate-300">{r.finalScore.toFixed(3)}</td>
                    <td className="px-4 py-2 text-slate-500">{r.rankDelta == null ? '—' : (r.rankDelta > 0 ? `+${r.rankDelta}` : r.rankDelta)}</td>
                    <td className="px-4 py-2">
                      <span className={
                        r.promotionRecommendation === 'PROMOTE' ? 'text-emerald-400'
                          : r.promotionRecommendation === 'REJECT' ? 'text-rose-400' : 'text-amber-400'
                      }>
                        {r.promotionRecommendation}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800/50 flex items-center gap-2 text-[10px] font-mono text-slate-500 uppercase tracking-widest">
          <AlertTriangle size={12} className="text-amber-400" /> Missed Opportunities (last 24h, diagnostic only)
        </div>
        {missed === null ? (
          <div className="py-8 text-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">Loading...</div>
        ) : missed.length === 0 ? (
          <div className="p-6">
            <AwaitingSignal label="Missed Opportunities" emptyResult reason="No PROMOTE-tier candidate stalled in the funnel in the last 24h - or none has been detected yet." />
          </div>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {missed.slice(0, 30).map((m, i) => (
              <div key={`${m.symbol}-${i}`} className="px-4 py-2 flex justify-between items-center text-[11px] font-mono">
                <div className="flex items-center gap-2">
                  <span className="text-white font-bold">{m.symbol}</span>
                  <span className="text-slate-500">{m.classification}</span>
                </div>
                <span className="text-slate-600 text-[10px]">{new Date(m.detectedAt).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
