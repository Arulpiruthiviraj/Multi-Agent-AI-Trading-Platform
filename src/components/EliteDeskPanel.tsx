/**
 * ==========================================================
 * Module: EliteDeskPanel
 *
 * Observability for desk-intelligence: default NO TRADE, news as catalyst,
 * regime-family relevance. Does not fabricate P&L or enable live trading.
 * ==========================================================
 */
import React, { useEffect, useState } from "react";
import AwaitingSignal from "./shared/AwaitingSignal";

interface DeskPayload {
  ok: boolean;
  defaultDecision: string;
  liveIdeaGenerationEnabled: boolean;
  newsEmitsTradeIdeas: boolean;
  minRiskRewardRatio: number;
  noTradeReasons: { code: string; label: string }[];
  recentCatalysts: {
    symbol: string;
    headline: string;
    catalystStrength: string;
    tradingBias: string;
    contribution: number;
    source: string;
  }[];
  regimeFamilyRelevance: Record<string, Record<string, number>>;
}

export default function EliteDeskPanel() {
  const [data, setData] = useState<DeskPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v2/desk/intelligence")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData(await r.json());
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return <AwaitingSignal label="Desk intelligence" reason={`GET /api/v2/desk/intelligence failed: ${error}`} />;
  }
  if (!data) {
    return <AwaitingSignal label="Desk intelligence" reason="Loading reviewed desk overlay (not a live edge claim)." />;
  }

  const sideways = data.regimeFamilyRelevance.SIDEWAYS_RANGE;

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-white uppercase tracking-widest">Desk overlay</h3>
        <span className="text-[10px] font-mono text-amber-400 uppercase tracking-widest">
          Default: {data.defaultDecision}
        </span>
      </div>
      <p className="text-[11px] text-slate-400 mb-4">
        Autobot idea generation: {data.liveIdeaGenerationEnabled ? "ON" : "OFF"}. News emits trade ideas:{" "}
        {data.newsEmitsTradeIdeas ? "YES (override)" : "NO — catalyst only"}. Minimum R:R {data.minRiskRewardRatio}.
        This panel does not claim a statistical edge.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        {sideways && Object.entries(sideways).map(([family, rel]) => (
          <div key={family} className="border border-slate-800 rounded p-2">
            <div className="text-[10px] font-mono text-slate-500 uppercase">{family} @ range</div>
            <div className="text-sm font-mono text-slate-200">{Number(rel).toFixed(2)}</div>
          </div>
        ))}
      </div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">Recent news catalysts</div>
      {data.recentCatalysts.length === 0 ? (
        <AwaitingSignal compact emptyResult reason="No NEWS_CATALYST events recorded in this process yet." />
      ) : (
        <ul className="space-y-2">
          {data.recentCatalysts.slice(0, 6).map((c, i) => (
            <li key={`${c.symbol}-${i}`} className="text-[11px] font-mono text-slate-300 border-b border-slate-800 pb-1">
              {c.symbol} {c.tradingBias} {c.catalystStrength} contrib {c.contribution} — {c.headline.slice(0, 80)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
