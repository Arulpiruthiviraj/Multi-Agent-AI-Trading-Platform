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

const SIMULATED_NEWS_TEMPLATES: Record<string, string[]> = {
  AAPL: [
    "AAPL: Supply chain whispers suggest next-generation processor node yields are exceeding initial wafer forecasts by 8%.",
    "Apple Inc (AAPL) pre-orders for artificial intelligence enabled mobile chipsets reach parity with high-end demand estimates.",
    "AAPL receives price target upgrades to $235 as brokerages model premium hardware upgrade super-cycles."
  ],
  MSFT: [
    "MSFT: Azure cloud infrastructure expansions see 42% sequential acceleration in enterprise database allocation contracts.",
    "Microsoft Corp (MSFT) secures dual-layer cyber-defense software protocol standards across major global logistics grids.",
    "MSFT launches specialized generative modeling servers configured for real-time quantum mechanics computation."
  ],
  NVDA: [
    "NVIDIA Corp (NVDA) Blackwell core architectures enter full scale production, clearing packaging bottleneck constraints.",
    "NVDA: Large language platform capital expenditures show sustained demand for cluster-level parallel computing pipelines.",
    "NVIDIA (NVDA) secures multi-billion enterprise server deployment contracts from regional state infrastructure partners."
  ],
  AMD: [
    "AMD introduces high-performance computing APUs tuned to rival enterprise cloud training margins.",
    "Advanced Micro Devices (AMD) receives custom server chip allocation validation from prominent server manufacturers.",
    "AMD: Technical reviews indicate 3nm node configurations operate with optimal thermal efficiency vs direct counterparts."
  ],
  SPY: [
    "SPY INDEX WATCH: Global equities absorb macro-liquidity signals as consumer spend metrics holding above baseline thresholds.",
    "S&P 500 Index (SPY) experiences largest single-session options block sweep volume of the current calendar fiscal half.",
    "SPY consolidates at key technical wedge resistance level as buyers bid short-term structural index flows."
  ],
  GLD: [
    "GOLD (GLD) spot prices scale to record momentum on sovereign asset reserve diversification policies.",
    "GLD: Defensive asset rotation triggers gold spot breakouts above historical price channel standard deviations.",
    "Gold ETF (GLD) logs 15 straight sessions of positive net asset inflows, marking structural shift in inflation hedge portfolios."
  ],
  TLT: [
    "TREASURY FUTURES (TLT): Long-duration yields settle as primary inflation indicators matching soft landing models.",
    "TLT: Institutional bond blocks aggressively swap cash reserves to 20-Year treasury vehicles to lock yield ratios.",
    "TLT consolidates around structural support levels as macroeconomic monetary committees signal stable asset balance sheets."
  ]
};

const GLOBAL_MACRO_NEWS = [
  "FOMC MINUTES: Swaps markets now register 72% probability of capital cost easing cycle commencing in the target quarter.",
  "GLOBAL SHOCKWAVES: Sovereign index spreads tighten to historic lows as cross-border trade flow indices resume expansion.",
  "OIL & COMMODITIES: Global crude inputs range-bound as logistics channels route through secure oceanic shipping channels.",
  "VIX INDEX: Market volatility gauges drift to ultra-compressed baselines while premium indices trade with clean price discovery."
];

/* === COMPONENT: AlpacaNewsTicker === */
/*
  This component fetches real-time streaming market news items.
  When offline, it uses mock templates. Includes marquee auto-scroll logic
  and highlighting for symbol tags.
*/
export default function AlpacaNewsTicker({ targetSymbol }: AlpacaNewsTickerProps) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  const tickerRef = useRef<HTMLDivElement>(null);

  const fetchAlpacaNews = async () => {
    setIsLoading(true);
    setErrorStatus(null);
    try {
      // Endpoint `/api/v1/alpaca/news?symbol=XXX`
      const response = await fetch(`/api/v1/alpaca/news?symbol=${targetSymbol}`);
      const data = await response.json();

      if (response.ok && data.news && Array.isArray(data.news) && data.news.length > 0) {
        const formatted = data.news.map((item: any, idx: number) => ({
          id: item.id?.toString() || `live-${idx}`,
          headline: item.headline,
          symbols: item.symbols || [targetSymbol],
          created_at: item.created_at || new Date().toISOString(),
          source: item.source || "Alpaca",
          url: item.url
        }));
        setNews(formatted);
        setIsLive(true);
      } else {
        // Fall back to robust simulated news but log unconfigured / zero results
        const msg = data.error || "No current news items found";
        handleFallback(msg);
      }
    } catch (err: any) {
      handleFallback(err.message || "Network error querying news endpoint");
    } finally {
      setIsLoading(false);
    }
  };

  const handleFallback = (reason: string) => {
    setErrorStatus(reason);
    setIsLive(false);

    // Build unique customized simulated news
    const items: NewsItem[] = [];
    const now = Date.now();

    // 1. Grab target symbol news templates
    const templates = SIMULATED_NEWS_TEMPLATES[targetSymbol] || SIMULATED_NEWS_TEMPLATES["SPY"];
    templates.forEach((headline, index) => {
      items.push({
        id: `sim-asset-${index}`,
        headline,
        symbols: [targetSymbol],
        created_at: new Date(now - index * 1000 * 60 * 15).toISOString(),
        source: index === 0 ? "Bloomberg" : index === 1 ? "Reuters" : "Dow Jones"
      });
    });

    // 2. Mix in global macro news
    GLOBAL_MACRO_NEWS.forEach((headline, index) => {
      items.push({
        id: `sim-macro-${index}`,
        headline,
        symbols: ["GLOBAL", "MACRO"],
        created_at: new Date(now - index * 1005 * 60 * 25).toISOString(),
        source: index % 2 === 0 ? "WSJ" : "FT"
      });
    });

    // Sort by date equivalent
    items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    setNews(items);
  };

  useEffect(() => {
    fetchAlpacaNews();
    const interval = setInterval(fetchAlpacaNews, 120000); // refresh every 2 mins
    return () => clearInterval(interval);
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
              {isLive ? "ALPACA API LIVE" : "SIMULATED NEWS STREAM"}
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
            Awaiting News Stream buffers...
          </div>
        )}
      </div>
    </div>
  );
}
