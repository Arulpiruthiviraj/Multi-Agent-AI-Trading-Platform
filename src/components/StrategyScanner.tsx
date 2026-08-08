/**
 * ==========================================================
 * Module:
 * StrategyScanner.tsx
 *
 * Purpose:
 * Core implementation and logic for the StrategyScanner.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for StrategyScannerx
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

import React, { useState, useEffect } from "react";
import { Activity, Target, TrendingUp, TrendingDown, Minus, Filter } from "lucide-react";

interface ScannerProps {
  assetPrices: Record<string, number>;
  selectedAlertSymbol: string;
  setSelectedAlertSymbol: (symbol: string) => void;
}

export default function StrategyScanner({ assetPrices, selectedAlertSymbol, setSelectedAlertSymbol }: ScannerProps) {
  const [scannerData, setScannerData] = useState<any[]>([]);
  const [filter, setFilter] = useState<"ALL" | "BUY" | "SELL">("ALL");

  const getMockPrices = (symbol: string, currentPrice: number, base: number, length = 40) => {
    const prices: number[] = [];
    const textSeed = symbol.charCodeAt(0) + (symbol.charCodeAt(1) || 0);
    for (let i = 0; i < length; i++) {
      if (i === length - 1) {
        prices.push(currentPrice);
      } else {
        const progress = i / (length - 1);
        const wave1 = 0;
        const wave2 = 0;
        const trend = (currentPrice - (base * 0.95)) * progress;
        let priceValue = (base * 0.95) + trend + (wave1 + wave2) * base;
        
        // Inject volatility pattern for RSI triggers
        if (symbol.length === 3) priceValue *= 0.98; // Tends lower -> Oversold
        if (symbol.length === 4 && symbol.charCodeAt(0) % 2 === 0) priceValue *= 1.02; // Tends higher -> Overbought

        prices.push(parseFloat(Math.max(0.01, priceValue).toFixed(2)));
      }
    }
    return prices;
  };

  const calculateWildersRSI = (prices: number[]) => {
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      if (i <= 14) {
        avgGain += gain;
        avgLoss += loss;
        if (i === 14) {
          avgGain /= 14;
          avgLoss /= 14;
        }
      } else {
        avgGain = ((avgGain * 13) + gain) / 14;
        avgLoss = ((avgLoss * 13) + loss) / 14;
      }
    }
    if (avgLoss === 0) return 100;
    if (avgGain === 0) return 0;
    return 100 - (100 / (1 + (avgGain / avgLoss)));
  };

  useEffect(() => {
    const basePrices: Record<string, number> = {
      AAPL: 175.20, MSFT: 415.50, NVDA: 875.12, AMD: 170.45,
      SPY: 510.30, GLD: 215.10, TLT: 94.60, TSLA: 178.40, BTC: 64250.00
    };

    const data = Object.keys(basePrices).map(sym => {
      const current = assetPrices[sym] || basePrices[sym];
      const prices = getMockPrices(sym, current, basePrices[sym]);
      const rsi = calculateWildersRSI(prices);
      
      let signal = "NEUTRAL";
      if (rsi < 30) signal = "BUY";
      else if (rsi > 70) signal = "SELL";

      return {
        symbol: sym,
        price: current,
        rsi: parseFloat(rsi.toFixed(2)),
        signal
      };
    });

    setScannerData(data.sort((a, b) => a.symbol.localeCompare(b.symbol)));
  }, [assetPrices]);

  const filteredData = scannerData.filter(d => filter === "ALL" || d.signal === filter);

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
                 Real-time L2 order flow and technical indicator analysis.
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
              {filteredData.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-slate-500 text-sm font-mono">
                    No {filter !== "ALL" ? filter : ""} signals found in current scan.
                  </td>
                </tr>
              ) : (
                filteredData.map((row) => (
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
                          <div className="text-[10px] text-slate-500 font-mono">EQUITY/CRYPTO</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 text-right pr-8 font-mono text-slate-300">
                      ${row.price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                    </td>
                    <td className="py-4 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden relative">
                          <div className="absolute left-[30%] top-0 bottom-0 w-px bg-emerald-500/50 z-10"></div>
                          <div className="absolute left-[70%] top-0 bottom-0 w-px bg-rose-500/50 z-10"></div>
                          <div 
                            className={`h-full rounded-full ${row.rsi < 30 ? 'bg-emerald-400' : row.rsi > 70 ? 'bg-rose-400' : 'bg-slate-400'}`}
                            style={{ width: `${Math.min(100, Math.max(0, row.rsi))}%` }}
                          ></div>
                        </div>
                        <span className={`font-mono text-[11px] font-bold ${row.rsi < 30 ? 'text-emerald-400' : row.rsi > 70 ? 'text-rose-400' : 'text-slate-400'}`}>
                          {row.rsi.toFixed(1)}
                        </span>
                      </div>
                    </td>
                    <td className="py-4">
                      {row.signal === "BUY" && (
                        <div className="inline-flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-widest">
                          <TrendingUp size={12} /> BUY (OVERSOLD)
                        </div>
                      )}
                      {row.signal === "SELL" && (
                        <div className="inline-flex items-center gap-1.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-widest">
                          <TrendingDown size={12} /> SELL (OVERBOUGHT)
                        </div>
                      )}
                      {row.signal === "NEUTRAL" && (
                        <div className="inline-flex items-center gap-1.5 bg-slate-800/50 border border-slate-700/50 text-slate-400 px-2.5 py-1 rounded text-[10px] font-mono font-bold tracking-widest">
                          <Minus size={12} /> NEUTRAL
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
