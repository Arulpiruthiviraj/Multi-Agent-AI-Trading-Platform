import React, { useEffect, useState } from "react";
import { Globe, RefreshCw, AlertCircle, Newspaper } from "lucide-react";

interface LiveNewsItem {
  id: string;
  headline: string;
  symbols: string[];
  source: string;
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
}

export default function LiveMarketNewsTicker() {
  const [news, setNews] = useState<LiveNewsItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);

  const fetchLiveNews = async () => {
    setIsLoading(true);
    setIsError(false);
    try {
      const response = await fetch("/api/v1/news/live");
      if (!response.ok) throw new Error("Failed to fetch news");
      const data = await response.json();
      if (data.news && Array.isArray(data.news)) {
        setNews(data.news);
      } else {
        setNews([]);
      }
    } catch (e) {
      console.error(e);
      setIsError(true);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLiveNews();
    const interval = setInterval(fetchLiveNews, 300000); // 5 mins
    return () => clearInterval(interval);
  }, []);

  const doubledNews = [...news, ...news];

  if (isError || (!isLoading && news.length === 0)) {
    return null; // Hide if failing completely
  }

  return (
    <div className="w-full bg-[#0A0F16] border-b border-indigo-500/20 shadow-[0_0_15px_rgba(99,102,241,0.1)] relative z-50 flex h-8 items-center text-[10px] sm:text-xs">
      <style>{`
        @keyframes ticker-scroll {
          0% { transform: translate3d(0, 0, 0); }
          100% { transform: translate3d(-50%, 0, 0); }
        }
        .ticker-marquee {
          overflow: hidden;
          white-space: nowrap;
          display: flex;
          width: 100%;
        }
        .ticker-content {
          display: inline-flex;
          align-items: center;
          animation: ticker-scroll 50s linear infinite;
        }
        .ticker-content:hover {
          animation-play-state: paused;
        }
      `}</style>
      
      <div className="flex items-center gap-1.5 px-3 md:px-4 shrink-0 bg-[#0F172A] h-full border-r border-indigo-500/20 text-indigo-400 font-mono uppercase tracking-widest font-bold">
        {isLoading ? (
          <RefreshCw size={12} className="animate-spin text-indigo-400" />
        ) : (
          <Globe size={12} className="text-indigo-400 animate-pulse" />
        )}
        <span className="hidden sm:inline">LIVE MARKET FEED</span>
        <span className="sm:hidden">LIVE</span>
      </div>

      <div className="ticker-marquee h-full items-center">
        {news.length > 0 ? (
          <div className="ticker-content">
            {doubledNews.map((item, idx) => (
              <div key={`${item.id}-${idx}`} className="flex items-center space-x-3 mx-4 flex-shrink-0">
                <span className={`font-mono font-bold uppercase ${item.sentiment === 'BULLISH' ? 'text-emerald-400' : item.sentiment === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'}`}>
                  [{item.sentiment}]
                </span>
                
                <span className="font-mono text-slate-200">
                  {item.headline}
                </span>
                
                {item.symbols && item.symbols.length > 0 && (
                  <div className="flex gap-1">
                    {item.symbols.map(sym => (
                      <span key={sym} className="px-1.5 py-0.5 rounded text-[9px] bg-slate-800 text-slate-300 border border-slate-700">
                        {sym}
                      </span>
                    ))}
                  </div>
                )}
                
                <span className="text-slate-500 font-mono italic px-2 border-l border-slate-700 ml-2">
                  {item.source}
                </span>

                <div className="w-1.5 h-1.5 rounded-full bg-slate-700 mx-2"></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-slate-500 px-4 font-mono">Initializing deep research search grounding...</div>
        )}
      </div>
    </div>
  );
}
