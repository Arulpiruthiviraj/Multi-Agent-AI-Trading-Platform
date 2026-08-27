/**
 * ==========================================================
 * Module: StrategyScanner
 *
 * Purpose:
 * Phase 3B of FINAL_ANALYSIS.md's 4-phase remediation plan. This used to fabricate a 40-bar price
 * series per symbol via a charCodeAt()-seeded formula (getMockPrices()) and run a real Wilder's
 * RSI calculation on that fake series - a mathematically correct signal computed on fictional
 * input. Now fetches GET /api/v2/strategy/rsi-scan, which computes the same RSI math server-side
 * over real cached OHLCV bars (src/server/engines/RSIEngine.ts, the same engine BacktestEngine
 * uses). A symbol with too little real history (or BTC, which Alpaca's equities-bars endpoint
 * doesn't serve) is shown as AWAITING SIGNAL with its real reason, never a fabricated number.
 * ==========================================================
 */

import React, { useState, useEffect, useRef } from "react";
import { Activity, TrendingUp, TrendingDown, Minus, Filter } from "lucide-react";
import AwaitingSignal from "./shared/AwaitingSignal";
import CandidateRankingPanel from "./CandidateRankingPanel";
import CandidateRankingHistoryPanel from "./CandidateRankingHistoryPanel";
import SubscriptionPriorityQueuePanel from "./SubscriptionPriorityQueuePanel";

interface ScannerProps {
  selectedAlertSymbol: string;
  setSelectedAlertSymbol: (symbol: string) => void;
}

interface RsiScanRow {
  symbol: string;
  dataAvailable: boolean;
  price?: number;
  rsi?: number;
  signal?: "OVERBOUGHT" | "OVERSOLD" | "NEUTRAL";
  barsUsed?: number;
  reason?: string;
}

interface AssetOpportunityRow {
  symbol: string;
  assetClass: string;
  safety: "SAFE" | "WATCH" | "BLOCK";
  eligibleForTradeIdea: boolean;
  reasons: string[];
  honesty: string;
}

export default function StrategyScanner({ selectedAlertSymbol, setSelectedAlertSymbol }: ScannerProps) {
  const [scannerData, setScannerData] = useState<RsiScanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  const [overlayOpps, setOverlayOpps] = useState<AssetOpportunityRow[]>([]);
  const [overlayNote, setOverlayNote] = useState("Multi-asset overlay default OFF — existing Argus RSI scan unchanged.");
  const [intelNote, setIntelNote] = useState("Opportunity loop default OFF — IEX universe stays markets.json benchmarks.");
  const [intelScan, setIntelScan] = useState<{ scanned: number; rejected: number; shortlisted: number; subscribeRequested: number; ideasEmitted: number } | null>(null);

  // Real perf fix (2026-08-18): 60s poll with no cancellation.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      fetch("/api/v2/strategy/rsi-scan", { signal: controller.signal })
        .then(r => r.json())
        .then(json => {
          if (!cancelled && json.ok) {
            setScannerData([...json.results].sort((a: RsiScanRow, b: RsiScanRow) => a.symbol.localeCompare(b.symbol)));
            setLoading(false);
          }
        })
        .catch((e) => { if (!cancelled && e?.name !== 'AbortError') setLoading(false); });
      fetch("/api/v2/multi-asset/universe", { signal: controller.signal })
        .then(r => r.json())
        .then(json => {
          if (cancelled || !json.ok) return;
          setOverlayEnabled(!!json.enabled);
          setOverlayOpps(Array.isArray(json.opportunities) ? json.opportunities : []);
          setOverlayNote(json.reason || json.honesty || "OPPORTUNITY is not an order.");
        })
        .catch((e) => { if (!cancelled && e?.name !== 'AbortError') { /* overlay optional */ } });
      fetch("/api/v2/continuous-intelligence/status", { signal: controller.signal })
        .then(r => r.json())
        .then(json => {
          if (cancelled || !json.ok) return;
          setIntelNote(json.honesty || json.consensusNote);
          if (json.lastOpportunityScan) setIntelScan(json.lastOpportunityScan);
        })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); abortRef.current?.abort(); };
  }, []);

  const signalOf = (row: RsiScanRow): "BUY" | "SELL" | "NEUTRAL" | "NONE" => {
    if (!row.dataAvailable) return "NONE";
    if (row.signal === "OVERSOLD") return "BUY";
    if (row.signal === "OVERBOUGHT") return "SELL";
    return "NEUTRAL";
  };

  const filteredData = scannerData.filter(d => filter === "ALL" || signalOf(d) === filter);

  return (
    <div className="animate-fade-in flex flex-col gap-6">
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-500/10 p-3 rounded border border-indigo-500/20 text-indigo-400">
               <Activity size={24} />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white uppercase tracking-widest">Global Strategy Scanner</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                 Real 14-period Wilder RSI over real cached OHLCV bars.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Filter size={14} className="text-slate-500 mr-2" />
            <button
              onClick={() => setFilter("ALL")}
              className={`px-3 py-1 text-[10px] font-mono font-black rounded border transition-all ${filter === "ALL" ? "bg-slate-700 border-slate-600 text-white" : "bg-[#111822] border-slate-800 text-slate-500 hover:text-slate-300"}`}
            >
              ALL
            </button>
            <button
              onClick={() => setFilter("BUY")}
              className={`px-3 py-1 text-[10px] font-mono font-black rounded border transition-all ${filter === "BUY" ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400" : "bg-[#111822] border-slate-800 text-slate-500 hover:text-slate-300"}`}
            >
              BUY SIGNALS
            </button>
            <button
              onClick={() => setFilter("SELL")}
              className={`px-3 py-1 text-[10px] font-mono font-black rounded border transition-all ${filter === "SELL" ? "bg-rose-500/20 border-rose-500/40 text-rose-400" : "bg-[#111822] border-slate-800 text-slate-500 hover:text-slate-300"}`}
            >
              SELL SIGNALS
            </button>
          </div>
        </div>

        <div className="mb-6 border border-slate-800 rounded-lg p-4 bg-[#111822]">
          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">Continuous intelligence</p>
          <p className="text-xs text-slate-400">{intelNote}</p>
          {intelScan && (
            <p className="text-[10px] font-mono text-slate-500 mt-2">
              scanned {intelScan.scanned} · rejected {intelScan.rejected} · shortlisted {intelScan.shortlisted} · subscribe requested {intelScan.subscribeRequested} · ideas emitted {intelScan.ideasEmitted} (must stay 0)
            </p>
          )}
        </div>

        <div className="mb-6">
          <CandidateRankingPanel />
        </div>

        <div className="mb-6">
          <CandidateRankingHistoryPanel />
        </div>

        <div className="mb-6">
          <SubscriptionPriorityQueuePanel />
        </div>

        <div className="mb-6 border border-slate-800 rounded-lg p-4 bg-[#111822]">
          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">Asset class overlay</p>
          <p className="text-xs text-slate-400 mb-3">{overlayEnabled ? overlayNote : overlayNote}</p>
          {!overlayEnabled && (
            <p className="text-[10px] font-mono text-slate-600">ARGUS_MULTI_ASSET_ENABLED is not true. AAPL/QQQ/IWM RSI scan is unchanged. LIVE remains NO-GO.</p>
          )}
          {overlayEnabled && overlayOpps.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[10px] font-mono">
                <thead>
                  <tr className="text-slate-500 uppercase tracking-widest">
                    <th className="py-1 pr-3">Symbol</th>
                    <th className="py-1 pr-3">Class</th>
                    <th className="py-1 pr-3">Safety</th>
                    <th className="py-1">Idea-eligible</th>
                  </tr>
                </thead>
                <tbody>
                  {overlayOpps.map((row) => (
                    <tr key={row.symbol} className="border-t border-slate-800 text-slate-300">
                      <td className="py-1 pr-3">{row.symbol}</td>
                      <td className="py-1 pr-3">{row.assetClass}</td>
                      <td className={`py-1 pr-3 ${row.safety === 'BLOCK' ? 'text-rose-400' : row.safety === 'WATCH' ? 'text-amber-400' : 'text-emerald-400'}`}>{row.safety}</td>
                      <td className="py-1">{row.eligibleForTradeIdea ? 'YES (still needs ChiefTrader + 24 gates)' : 'NO — not an order'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                <th className="pb-3 pl-4 font-medium">Asset</th>
                <th className="pb-3 font-medium text-right pr-8">Current Price</th>
                <th className="pb-3 font-medium text-center">14-Period RSI</th>
                <th className="pb-3 font-medium">Action Signal</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-slate-500 text-sm font-mono">
                    Loading real RSI scan...
                  </td>
                </tr>
              ) : filteredData.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-slate-500 text-sm font-mono">
                    No {filter !== "ALL" ? filter : ""} signals found in current scan.
                  </td>
                </tr>
              ) : (
                filteredData.map((row) => {
                  const signal = signalOf(row);
                  return (
                    <tr
                      key={row.symbol}
                      onClick={() => setSelectedAlertSymbol(row.symbol)}
                      className={`border-b border-slate-800/50 cursor-pointer transition-colors ${selectedAlertSymbol === row.symbol ? 'bg-indigo-500/5' : 'hover:bg-[#111822]/80'}`}
                    >
                      <td className="py-4 pl-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-[10px] font-bold text-white">
                            {row.symbol.substring(0, 2)}
                          </div>
                          <div>
                            <div className="font-bold text-slate-200">{row.symbol}</div>
                            <div className="text-[10px] text-slate-500 font-mono">EQUITY</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-4 text-right pr-8 font-mono text-slate-300">
                        {row.dataAvailable
                          ? `$${row.price!.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : <span className="text-slate-600">--</span>}
                      </td>
                      <td className="py-4 text-center">
                        {!row.dataAvailable ? (
                          <AwaitingSignal compact reason={row.reason} />
                        ) : (
                          <div className="flex items-center justify-center gap-2">
                            <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden relative">
                              <div className="absolute left-[30%] top-0 bottom-0 w-px bg-emerald-500/50 z-10"></div>
                              <div className="absolute left-[70%] top-0 bottom-0 w-px bg-rose-500/50 z-10"></div>
                              <div
                                className={`h-full rounded-full ${row.rsi! < 30 ? 'bg-emerald-400' : row.rsi! > 70 ? 'bg-rose-400' : 'bg-slate-400'}`}
                                style={{ width: `${Math.min(100, Math.max(0, row.rsi!))}%` }}
                              ></div>
                            </div>
                            <span className={`font-mono text-[11px] font-bold ${row.rsi! < 30 ? 'text-emerald-400' : row.rsi! > 70 ? 'text-rose-400' : 'text-slate-400'}`}>
                              {row.rsi!.toFixed(1)}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="py-4">
                        {signal === "BUY" && (
                          <div className="inline-flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-widest">
                            <TrendingUp size={12} /> BUY (OVERSOLD)
                          </div>
                        )}
                        {signal === "SELL" && (
                          <div className="inline-flex items-center gap-1.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-widest">
                            <TrendingDown size={12} /> SELL (OVERBOUGHT)
                          </div>
                        )}
                        {signal === "NEUTRAL" && (
                          <div className="inline-flex items-center gap-1.5 bg-slate-800/50 border border-slate-700/50 text-slate-400 px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-widest">
                            <Minus size={12} /> NEUTRAL
                          </div>
                        )}
                        {signal === "NONE" && (
                          <span className="text-[10px] font-mono text-slate-600">--</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
