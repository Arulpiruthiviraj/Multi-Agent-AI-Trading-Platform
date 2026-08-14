/**
 * ==========================================================
 * Module: StrategyProfitSunburst
 *
 * This used to visualize an invented strategy hierarchy - "Momentum" > Breakout/Trend Follow/
 * Whipsaw, "Mean Reversion" > RSI Divergence/Bollinger Bounce/Pairs Trading, "Arbitrage" > Stat
 * Arb/Triangular/Latency/Fee Drag - none of which are real Argus strategies, with every leaf
 * value re-randomized on every chart redraw via a `Date.now() % 1000` jitter multiplier.
 *
 * Now backed by GET /api/v2/portfolio/pnl-by-symbol: real realized P&L (trades.profitLoss, real
 * FILLED SELL orders only) summed per real symbol over a real selectable horizon. There is no
 * real per-"strategy" breakdown anywhere in this codebase - grouping by real symbol is what real
 * data can actually answer.
 * ==========================================================
 */

import React, { useRef, useEffect, useState } from 'react';
import * as d3 from 'd3';
import { Target, TrendingUp, TrendingDown, Clock } from 'lucide-react';
import AwaitingSignal from './shared/AwaitingSignal';

export default function StrategyProfitSunburst() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [timeHorizon, setTimeHorizon] = useState<"1W" | "1M" | "YTD">("1M");
  const [data, setData] = useState<{ symbol: string; pnl: number; type: 'profit' | 'loss' }[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v2/portfolio/pnl-by-symbol?horizon=${timeHorizon}`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        if (json.ok) {
          setAvailable(json.available);
          setData(json.data || []);
          setReason(json.reason || null);
        } else {
          setAvailable(false);
          setReason(json.error || 'Request failed.');
        }
      })
      .catch(e => { if (!cancelled) { setAvailable(false); setReason(e.message); } });
    return () => { cancelled = true; };
  }, [timeHorizon]);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || !data || data.length === 0) return;

    const width = 400;
    const height = 400;
    const radius = Math.min(width, height) / 2;

    const hierarchyData = {
      name: 'Portfolio',
      children: data.map(d => ({ name: d.symbol, value: Math.abs(d.pnl), pnl: d.pnl, type: d.type })),
    };

    d3.select(svgRef.current).selectAll("*").remove();

    const svg = d3.select(svgRef.current)
      .attr("viewBox", [0, 0, width, height].join(' '))
      .style("font", "10px sans-serif")
      .append("g")
      .attr("transform", `translate(${width / 2},${height / 2})`);

    const root = d3.hierarchy(hierarchyData)
      .sum((d: any) => d?.value || 0)
      .sort((a: any, b: any) => (b?.value || 0) - (a?.value || 0));

    const partition = d3.partition().size([2 * Math.PI, root.height + 1]);
    partition(root);

    const arc = d3.arc<any>()
      .startAngle((d: any) => d.x0)
      .endAngle((d: any) => d.x1)
      .padAngle((d: any) => Math.min((d.x1 - d.x0) / 2, 0.005))
      .padRadius(radius * 1.5 / root.height)
      .innerRadius((d: any) => d.y0 * radius / (root.height + 1))
      .outerRadius((d: any) => Math.max(d.y0 * radius / (root.height + 1), d.y1 * radius / (root.height + 1) - 1));

    const color = (d: any) => {
      if (d.depth === 0) return "transparent";
      return d.data.type === 'profit' ? '#10b981' : '#f43f5e';
    };

    const tooltip = d3.select(containerRef.current)
      .append("div")
      .style("position", "absolute")
      .style("visibility", "hidden")
      .style("background-color", "#0f172a")
      .style("border", "1px solid #334155")
      .style("border-radius", "4px")
      .style("padding", "8px")
      .style("color", "#f8fafc")
      .style("font-family", "ui-monospace, SFMono-Regular, monospace")
      .style("font-size", "10px")
      .style("z-index", "10")
      .style("pointer-events", "none")
      .style("box-shadow", "0 4px 6px -1px rgba(0, 0, 0, 0.5)");

    const format = d3.format("$,.2f");

    svg.append("g")
      .selectAll("path")
      .data(root.descendants().filter(d => d.depth > 0))
      .join("path")
      .attr("fill", color)
      .attr("fill-opacity", 0.8)
      .attr("d", arc)
      .attr("stroke", "#0f172a")
      .attr("stroke-width", 1.5)
      .style("cursor", "pointer")
      .on("mouseover", function (event, d: any) {
        d3.select(this).transition().duration(200).attr("fill-opacity", 1);
        const isProfit = d.data.type === "profit";
        const colorClass = isProfit ? "#34d399" : "#fb7185";
        const label = isProfit ? "Real Profit" : "Real Loss";
        tooltip.html(`<div style="font-weight: bold; margin-bottom: 4px;">${d.data.name}</div><div style="color: ${colorClass};">${label}: ${format(d.data.pnl)}</div>`)
          .style("visibility", "visible");
      })
      .on("mousemove", function (event) {
        tooltip.style("top", (event.pageY - 10) + "px").style("left", (event.pageX + 10) + "px");
      })
      .on("mouseout", function () {
        d3.select(this).transition().duration(200).attr("fill-opacity", 0.8);
        tooltip.style("visibility", "hidden");
      });

    svg.append("g")
      .attr("pointer-events", "none")
      .attr("text-anchor", "middle")
      .style("user-select", "none")
      .selectAll("text")
      .data(root.descendants().filter(d => d.depth > 0 && ((d as any).x1 - (d as any).x0) > 0.05))
      .join("text")
      .attr("transform", function (d: any) {
        const x = (d.x0 + d.x1) / 2 * 180 / Math.PI;
        const y = (d.y0 + d.y1) / 2 * radius / (root.height + 1);
        return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
      })
      .attr("dy", "0.35em")
      .attr("fill", "white")
      .attr("font-size", "10px")
      .attr("font-weight", "bold")
      .text((d: any) => d.data.name.length > 10 ? d.data.name.substring(0, 8) + '...' : d.data.name);

    const totalRealPnl = data.reduce((s, d) => s + d.pnl, 0);
    svg.append("text").attr("text-anchor", "middle").attr("dy", "-0.5em").attr("fill", "#94a3b8").attr("font-size", "10px").text("Real Net P&L");
    svg.append("text").attr("text-anchor", "middle").attr("dy", "1em").attr("fill", totalRealPnl >= 0 ? "#34d399" : "#fb7185").attr("font-size", "14px").attr("font-weight", "bold").text(format(totalRealPnl));

    return () => { tooltip.remove(); };
  }, [data]);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 animate-fade-in relative" ref={containerRef}>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
            <Target size={16} className="text-indigo-400" />
            Real P&L Attribution by Symbol
          </h3>
          <p className="text-[10px] font-mono text-slate-400 mt-1">
            Real realized profit/loss (trades.profitLoss) per symbol. No real per-strategy breakdown exists in this codebase.
          </p>
        </div>

        <div className="flex bg-slate-900 rounded p-1 border border-slate-800">
          {(["1W", "1M", "YTD"] as const).map((hz) => (
            <button
              key={hz}
              onClick={() => setTimeHorizon(hz)}
              className={`px-3 py-1 text-[10px] font-mono rounded transition-colors ${
                timeHorizon === hz
                  ? 'bg-indigo-500/20 text-indigo-400 font-bold border border-indigo-500/30'
                  : 'text-slate-500 hover:text-slate-300 border border-transparent'
              }`}
            >
              <span className="flex items-center gap-1">
                {hz === '1W' && <Clock size={10} />}
                {hz === '1M' && <TrendingUp size={10} />}
                {hz === 'YTD' && <TrendingDown size={10} />}
                {hz}
              </span>
            </button>
          ))}
        </div>
      </div>

      {available === false && (
        <div className="py-12 flex justify-center"><AwaitingSignal reason={reason || 'No real FILLED trades with realized P&L in this window.'} label="P&L Attribution" /></div>
      )}

      {available === null && (
        <div className="py-12 text-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">Loading real P&L attribution...</div>
      )}

      {available === true && (
        <div className="flex justify-center items-center w-full relative">
          <svg ref={svgRef} className="w-full max-w-[400px] h-[400px] drop-shadow-2xl" />
          <div className="absolute bottom-0 right-0 flex flex-col gap-2 bg-[#111822]/80 backdrop-blur border border-slate-800 p-3 rounded font-mono text-[9px] z-0">
             <div className="text-slate-400 font-bold uppercase mb-1 border-b border-slate-800 pb-1">Legend</div>
             <div className="flex items-center gap-2">
               <div className="w-3 h-3 rounded-sm bg-[#10b981] opacity-80"></div>
               <span className="text-slate-300">Real Net Profit</span>
             </div>
             <div className="flex items-center gap-2">
               <div className="w-3 h-3 rounded-sm bg-[#f43f5e] opacity-80"></div>
               <span className="text-slate-300">Real Net Loss</span>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
