/**
 * ==========================================================
 * Module:
 * AlpacaNewsTicker.tsx
 *
 * Purpose:
 * Core implementation and logic for the AlpacaNewsTicker.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AlpacaNewsTickerx
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

import React, { useEffect, useState, useRef } from "react";
import { Radio, AlertCircle, RefreshCw, Star, Newspaper } from "lucide-react";

interface NewsItem {
  id: string;
  headline: string;
  symbols: string[];
  created_at: string;
  source: string;
  url?: string;
}

interface AlpacaNewsTickerProps {
  targetSymbol: string;
}


/* === COMPONENT: AlpacaNewsTicker === */
/*
  This component fetches real-time streaming market news items.
  When offline, it uses default templates. Includes marquee auto-scroll logic
  and highlighting for symbol tags.
*/
export default function AlpacaNewsTicker({ targetSymbol }: AlpacaNewsTickerProps) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  const tickerRef = useRef<HTMLDivElement>(null);

  // Real bug found and fixed this pass: fetchAlpacaNews() used to set state unconditionally, with
  // no guard against a superseded request. If targetSymbol changed while a fetch for the OLD
  // symbol was still in flight, that stale response could still arrive and overwrite the ticker
  // with the wrong symbol's headlines after the new symbol's effect had already started - the
  // effect's own `cancelled` flag only ever gated whether the *next* poll got scheduled, not the
  // state updates from the in-flight call. Now takes an AbortSignal so a superseded request's
  // state updates are skipped entirely instead of racing the current one.
  const fetchAlpacaNews = async (symbol: string, signal: AbortSignal) => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/v1/alpaca/news?symbol=${symbol}`, { signal });
      const data = await response.json().catch(() => ({}));
      if (signal.aborted) return;

      if (response.ok && data.available !== false && Array.isArray(data.news) && data.news.length > 0) {
        const formatted = data.news.map((item: any, idx: number) => ({
          id: item.id?.toString() || `live-${idx}`,
          headline: item.headline,
          symbols: item.symbols || [symbol],
          created_at: item.created_at || new Date().toISOString(),
          source: item.source || (data.source === "NewsEngine" ? "NewsEngine" : "Alpaca"),
          url: item.url
        }));
        setNews(formatted);
        setIsLive(data.source === "alpaca" || data.source === "alpaca-ws");
        setErrorStatus(data.alpacaFallbackReason || null);
        return;
      }
      handleFallback(
        data.reason
        || data.error
        || (response.ok ? "No current news items found" : `News endpoint HTTP ${response.status}`),
      );
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal.aborted) return;
      handleFallback(err.message || "Network error querying news endpoint");
    } finally {
      if (!signal.aborted) setIsLoading(false);
    }
  };

  const handleFallback = (reason: string) => {
    setErrorStatus(reason);
    setIsLive(false);
    setNews([]);
  };

  useEffect(() => {
    let cancelled = false;
    let delayMs = 30000;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;

    const tick = async () => {
      controller = new AbortController();
      await fetchAlpacaNews(targetSymbol, controller.signal);
      if (cancelled) return;
      timer = setTimeout(tick, delayMs);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [targetSymbol]);

  // Double the list to support seamless infinite loop transition
  const doubledNews = [...news, ...news];

  return (
    <div className="w-full bg-[#111822] border border-slate-800 rounded-lg overflow-hidden flex flex-col relative">
      {/* CSS marquee styles */}
      <style>{`
        @keyframes marquee-scroll {
          0% {
            transform: translate3d(0, 0, 0);
          }
          100% {
            transform: translate3d(-50%, 0, 0);
          }
        }
        .marquee-container {
          overflow: hidden;
          white-space: nowrap;
          display: flex;
          width: 100%;
        }
        .marquee-inner {
          display: inline-flex;
          align-items: center;
          animation: marquee-scroll 45s linear infinite;
        }
        .marquee-inner:hover {
          animation-play-state: paused;
        }
      `}</style>

      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between px-3.5 py-1.5 border-b border-slate-800/80 bg-[#1A1F2B] text-[8px] font-mono tracking-widest uppercase text-slate-500">
        <div className="flex items-center gap-2">
          <Newspaper size={11} className="text-emerald-400" />
          <span>Alpaca News Engine Pipeline</span>
        </div>
        
        <div className="flex items-center gap-4">
          {/* Signal Indicator */}
          <div className="flex items-center gap-1.5">
            <span className={`relative flex h-2 w-2`}>
              {isLive && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${isLive ? "bg-emerald-500" : "bg-amber-500"}`}></span>
            </span>
            <span className={isLive ? "text-emerald-400 font-semibold" : "text-amber-500"}>
              {isLive ? "ALPACA API LIVE" : news.length > 0 ? "NEWSENGINE FALLBACK" : "NEWS UNAVAILABLE"}
            </span>
          </div>

          {/* Quick Info */}
          <span className="text-[8px] text-slate-600 hidden md:inline">
            Active Filter: <b className="text-slate-400">{targetSymbol}</b>
          </span>

          {/* Refresh action */}
          <button 
            onClick={fetchAlpacaNews}
            disabled={isLoading}
            className="hover:text-white transition-colors cursor-pointer flex items-center gap-1 active:scale-95"
          >
            <RefreshCw size={10} className={`${isLoading ? "animate-spin text-emerald-400" : ""}`} />
            <span>SYNC</span>
          </button>
        </div>
      </div>

      {/* Content wrapper */}
      <div className="py-2.5 bg-slate-950/40 relative flex items-center h-10 select-none">
        {news.length > 0 ? (
          <div className="marquee-container">
            <div className="marquee-inner">
              {doubledNews.map((item, idx) => (
                <div 
                  key={`${item.id}-${idx}`}
                  className="flex items-center space-x-3.5 mx-5 flex-shrink-0 cursor-default"
                >
                  {/* Badge */}
                  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-semibold font-mono">
                    <Star size={8} className="fill-indigo-400 text-indigo-400" />
                    {item.source}
                  </span>

                  {/* Headline text */}
                  <span className="text-[11px] font-mono text-slate-100 hover:text-emerald-400 transition-colors">
                    {item.headline}
                  </span>

                  {/* Symbols info */}
                  {item.symbols && item.symbols.length > 0 && (
                    <div className="flex gap-1">
                      {item.symbols.map((sym) => (
                        <span 
                          key={sym} 
                          className="px-1 text-[8px] font-mono bg-slate-800 text-slate-300 rounded border border-slate-700/50"
                        >
                          {sym}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Separator icon */}
                  <div className="h-1 w-1 rounded-full bg-slate-700 mx-4"></div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="w-full text-center text-xs font-mono text-slate-500 uppercase tracking-widest pl-4">
            Awaiting News Stream buffers...{errorStatus ? ` (${errorStatus})` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
