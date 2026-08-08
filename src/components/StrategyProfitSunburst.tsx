/**
 * ==========================================================
 * Module:
 * StrategyProfitSunburst.tsx
 *
 * Purpose:
 * Core implementation and logic for the StrategyProfitSunburst.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for StrategyProfitSunburstx
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

import React, { useRef, useEffect, useState } from 'react';
import * as d3 from 'd3';
import { Target, TrendingUp, TrendingDown, Clock } from 'lucide-react';

/**
 * StrategyProfitSunburst Component
 * 
 * Visualizes the profit and loss attribution across various trading strategies
 * using a hierarchical D3.js sunburst chart. It allows the user to switch
 * between different time horizons (1W, 1M, YTD) to see how strategy performance
 * evolves over time.
 */
export default function StrategyProfitSunburst() {
  // Reference to the SVG element where the D3 chart will be rendered
  const svgRef = useRef<SVGSVGElement | null>(null);
  
  // Reference to the container div, used for appending floating tooltips
  const containerRef = useRef<HTMLDivElement | null>(null);
  
  // State to track the currently selected time horizon for the data visualization
  const [timeHorizon, setTimeHorizon] = useState<"1W" | "1M" | "YTD">("1M");

  /**
   * Generates default hierarchical data representing strategy performance.
   * 
   * @param horizon The selected time horizon, which scales the monetary values.
   * @returns A structured object ready to be parsed by d3.hierarchy.
   */
  const generateData = (horizon: string) => {
    // Determine the scaling multiplier based on the selected horizon
    let multiplier = 1;
    if (horizon === "1W") multiplier = 0.2; // Smaller volume for 1 week
    if (horizon === "YTD") multiplier = 5;  // Larger volume for Year-to-Date

    // Return the root node 'Portfolio' with nested strategy categories and their sub-strategies
    return {
      name: "Portfolio",
      children: [
        {
          name: "Momentum",
          children: [
            // Each leaf node contains a name, a calculated randomized value, and a type (profit/loss)
            { name: "Breakout", value: Math.floor(4500 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "profit" },
            { name: "Trend Follow", value: Math.floor(3200 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "profit" },
            { name: "Whipsaw", value: Math.floor(1200 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "loss" }
          ]
        },
        {
          name: "Mean Reversion",
          children: [
            { name: "RSI Divergence", value: Math.floor(2800 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "profit" },
            { name: "Bollinger Bounce", value: Math.floor(1900 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "profit" },
            { name: "Pairs Trading", value: Math.floor(800 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "loss" }
          ]
        },
        {
          name: "Arbitrage",
          children: [
            { name: "Stat Arb", value: Math.floor(1500 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "profit" },
            { name: "Triangular", value: Math.floor(600 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "profit" },
            { name: "Latency", value: Math.floor(400 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "loss" },
            { name: "Fee Drag", value: Math.floor(300 * multiplier * ((Date.now() % 1000 / 1000) * 0.5 + 0.8)), type: "loss" }
          ]
        }
      ]
    };
  };

  /**
   * Effect hook to render the D3 sunburst chart whenever the timeHorizon changes.
   */
  useEffect(() => {
    // Ensure both refs are attached before attempting to manipulate the DOM with D3
    if (!svgRef.current || !containerRef.current) return;

    // Define the dimensions of the SVG canvas
    const width = 400;
    const height = 400;
    // Calculate the radius based on the smallest dimension
    const radius = Math.min(width, height) / 2;

    // Generate the hierarchical data for the current time horizon
    const data = generateData(timeHorizon);

    // Clear any previously rendered SVG content to prevent overlapping charts on re-renders
    d3.select(svgRef.current).selectAll("*").remove();

    // Initialize the main SVG group element and center it within the canvas
    const svg = d3.select(svgRef.current)
      .attr("viewBox", [0, 0, width, height].join(' ')) // Set viewBox for responsiveness
      .style("font", "10px sans-serif")
      .append("g")
      .attr("transform", `translate(${width / 2},${height / 2})`);

    // Create a D3 hierarchy from the data, sum up the values from leaf nodes to parents,
    // and sort the nodes based on value to display them sequentially.
    const root = d3.hierarchy(data)
      .sum((d: any) => d?.value || 0)
      .sort((a: any, b: any) => (b?.value || 0) - (a?.value || 0));

    // Configure the D3 partition layout generator
    const partition = d3.partition()
      .size([2 * Math.PI, root.height + 1]);

    // Apply the partition layout to our root hierarchy
    partition(root);

    // Define the arc generator function to draw the curved segments of the sunburst
    const arc = d3.arc<any>()
      .startAngle((d: any) => d.x0)   // Start angle of the segment
      .endAngle((d: any) => d.x1)     // End angle of the segment
      .padAngle((d: any) => Math.min((d.x1 - d.x0) / 2, 0.005)) // Add padding between adjacent segments
      .padRadius(radius * 1.5 / root.height) // Adjust padding calculation radius
      .innerRadius((d: any) => d.y0 * radius / (root.height + 1)) // Set inner radius based on depth
      .outerRadius((d: any) => Math.max(d.y0 * radius / (root.height + 1), d.y1 * radius / (root.height + 1) - 1)); // Set outer radius based on depth

    /**
     * Determines the color of an arc based on its depth and category name.
     * 
     * @param d The current data node in the hierarchy.
     * @returns A hex color string.
     */
    const color = (d: any) => {
      // The center root node is transparent
      if (d.depth === 0) return "transparent";
      
      // Level 1: Core strategy groups get distinct brand colors
      if (d.depth === 1) {
        if (d.data.name === "Momentum") return "#3b82f6"; // Blue
        if (d.data.name === "Mean Reversion") return "#8b5cf6"; // Purple
        if (d.data.name === "Arbitrage") return "#eab308"; // Yellow
      }
      
      // Level 2: Specific sub-strategies are colored by their outcome (profit or loss)
      if (d.depth === 2) {
        if (d.data.type === "profit") return "#10b981"; // Emerald
        if (d.data.type === "loss") return "#f43f5e"; // Rose
      }
      
      // Fallback color
      return "#334155";
    };

    // Create a tooltip div and append it to the container reference
    const tooltip = d3.select(containerRef.current)
      .append("div")
      .style("position", "absolute")
      .style("visibility", "hidden") // Initially hidden
      .style("background-color", "#0f172a")
      .style("border", "1px solid #334155")
      .style("border-radius", "4px")
      .style("padding", "8px")
      .style("color", "#f8fafc")
      .style("font-family", "ui-monospace, SFMono-Regular, monospace")
      .style("font-size", "10px")
      .style("z-index", "10")
      .style("pointer-events", "none") // Ensure tooltip doesn't block mouse events on the chart
      .style("box-shadow", "0 4px 6px -1px rgba(0, 0, 0, 0.5)");

    // Utility to format numbers as standard currency strings
    const format = d3.format("$,d");

    // Draw the sunburst arcs
    svg.append("g")
      .selectAll("path")
      .data(root.descendants().filter(d => d.depth > 0)) // Exclude the center root from being drawn
      .join("path")
      .attr("fill", color) // Apply the dynamic color function
      .attr("fill-opacity", (d: any) => d.depth === 1 ? 0.8 : 0.6) // Outer rings have lower opacity
      .attr("d", arc) // Apply the arc generator shape
      .attr("stroke", "#0f172a") // Add borders to the segments
      .attr("stroke-width", 1.5)
      .style("cursor", "pointer")
      
      // Event listener for mouse hovering over a segment
      .on("mouseover", function(event, d: any) {
        // Highlight the segment by setting opacity to 1
        d3.select(this)
          .transition()
          .duration(200)
          .attr("fill-opacity", 1);
          
        // Construct the HTML content for the tooltip
        let content = `<div style="font-weight: bold; margin-bottom: 4px;">${d.data.name}</div>`;
        
        if (d.depth === 2) {
          // If it's a leaf node, show profit vs loss details
          const isProfit = d.data.type === "profit";
          const colorClass = isProfit ? "#34d399" : "#fb7185";
          const label = isProfit ? "Profit" : "Loss";
          content += `<div style="color: ${colorClass};">${label}: ${format(d?.value || 0)}</div>`;
        } else {
          // If it's an inner node, just show total aggregated volume
          content += `<div style="color: #94a3b8;">Total Volume: ${format(d?.value || 0)}</div>`;
        }

        // Inject content and make tooltip visible
        tooltip.html(content)
          .style("visibility", "visible");
      })
      
      // Event listener for mouse moving over a segment to dynamically update tooltip position
      .on("mousemove", function(event) {
        tooltip
          .style("top", (event.pageY - 10) + "px") // Offset to avoid overlapping the cursor
          .style("left", (event.pageX + 10) + "px");
      })
      
      // Event listener for mouse leaving a segment
      .on("mouseout", function(event, d: any) {
        // Restore the original opacity of the segment
        d3.select(this)
          .transition()
          .duration(200)
          .attr("fill-opacity", d.depth === 1 ? 0.8 : 0.6);
        
        // Hide the tooltip
        tooltip.style("visibility", "hidden");
      });

    // Add text labels to the arcs
    svg.append("g")
      .attr("pointer-events", "none") // Ensure text doesn't interfere with mouseover events on paths
      .attr("text-anchor", "middle")
      .style("user-select", "none")
      .selectAll("text")
      // Only attach text labels to elements with enough angular space (width) to fit the text
      .data(root.descendants().filter(d => d.depth > 0 && ((d as any).x1 - (d as any).x0) > 0.05))
      .join("text")
      .attr("transform", function(d: any) {
        // Calculate the rotational angle and translation distance for the text
        const x = (d.x0 + d.x1) / 2 * 180 / Math.PI;
        const y = (d.y0 + d.y1) / 2 * radius / (root.height + 1);
        // Rotate text to follow the arc, and flip it if it's on the bottom half for readability
        return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
      })
      .attr("dy", "0.35em") // Vertically center the text
      .attr("fill", "white")
      .attr("font-size", (d: any) => d.depth === 1 ? "10px" : "8px") // Make inner text slightly larger
      .attr("font-weight", "bold")
      // Truncate long strategy names to fit inside the arcs
      .text((d: any) => d.data.name.length > 10 ? d.data.name.substring(0, 8) + '...' : d.data.name);

    // Append center static text (Label)
    svg.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "-0.5em")
      .attr("fill", "#94a3b8")
      .attr("font-size", "10px")
      .text("Total Volume");
      
    // Append center static text (Value) displaying the total sum of the entire hierarchy
    svg.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "1em")
      .attr("fill", "#f8fafc")
      .attr("font-size", "14px")
      .attr("font-weight", "bold")
      .text(format(root?.value || 0));

    // Cleanup function: remove the tooltip from the DOM when the component unmounts or re-renders
    return () => {
      tooltip.remove();
    };
  }, [timeHorizon]); // The effect depends on timeHorizon; it re-draws the chart when it changes.

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 animate-fade-in relative" ref={containerRef}>
      
      {/* Header section with title, description, and time horizon toggles */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
            <Target size={16} className="text-indigo-400" />
            Strategy Profit Attribution
          </h3>
          <p className="text-[10px] font-mono text-slate-400 mt-1">
            Hierarchical breakdown of profit vs loss contribution across active strategies.
          </p>
        </div>
        
        {/* Toggle buttons for selecting the data timeframe */}
        <div className="flex bg-slate-900 rounded p-1 border border-slate-800">
          {(["1W", "1M", "YTD"] as const).map((hz) => (
            <button
              key={hz}
              // Update state when a new horizon is clicked, triggering a chart re-draw
              onClick={() => setTimeHorizon(hz)}
              className={`px-3 py-1 text-[10px] font-mono rounded transition-colors ${
                timeHorizon === hz 
                  ? 'bg-indigo-500/20 text-indigo-400 font-bold border border-indigo-500/30' // Active state styling
                  : 'text-slate-500 hover:text-slate-300 border border-transparent'        // Inactive state styling
              }`}
            >
              <span className="flex items-center gap-1">
                {/* Dynamically assign an icon based on the horizon string */}
                {hz === '1W' && <Clock size={10} />}
                {hz === '1M' && <TrendingUp size={10} />}
                {hz === 'YTD' && <TrendingDown size={10} />}
                {hz}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Main visualization area */}
      <div className="flex justify-center items-center w-full relative">
        {/* SVG container controlled by D3 */}
        <svg ref={svgRef} className="w-full max-w-[400px] h-[400px] drop-shadow-2xl" />
        
        {/* Floating static legend placed in the bottom right of the chart area */}
        <div className="absolute bottom-0 right-0 flex flex-col gap-2 bg-[#111822]/80 backdrop-blur border border-slate-800 p-3 rounded font-mono text-[9px] z-0">
           <div className="text-slate-400 font-bold uppercase mb-1 border-b border-slate-800 pb-1">Legend</div>
           
           {/* Legend items mapping colors to data meanings */}
           <div className="flex items-center gap-2">
             <div className="w-3 h-3 rounded-sm bg-[#10b981] opacity-80"></div>
             <span className="text-slate-300">Net Profit</span>
           </div>
           <div className="flex items-center gap-2">
             <div className="w-3 h-3 rounded-sm bg-[#f43f5e] opacity-80"></div>
             <span className="text-slate-300">Net Loss</span>
           </div>
           <div className="flex items-center gap-2">
             <div className="w-3 h-3 rounded-sm bg-[#3b82f6] opacity-80"></div>
             <span className="text-slate-300">Momentum</span>
           </div>
           <div className="flex items-center gap-2">
             <div className="w-3 h-3 rounded-sm bg-[#8b5cf6] opacity-80"></div>
             <span className="text-slate-300">Mean Reversion</span>
           </div>
        </div>
      </div>
      
    </div>
  );
}
