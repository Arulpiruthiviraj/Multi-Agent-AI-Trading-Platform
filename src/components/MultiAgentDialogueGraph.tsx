/**
 * ==========================================================
 * Module:
 * MultiAgentDialogueGraph.tsx
 *
 * Purpose:
 * Core implementation and logic for the MultiAgentDialogueGraph.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for MultiAgentDialogueGraphx
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

import React, { useEffect, useRef } from "react";
import * as d3 from "d3";
import { MessageSquareShare } from "lucide-react";

/* === COMPONENT: MultiAgentDialogueGraph === */
/*
  Uses D3.js to render a visual representation of agents communicating in a network.
  Simulates message flows ('propose', 'veto', 'consensus') between nodes.
*/

type NodeDatum = d3.SimulationNodeDatum & {
  id: string;
  group: string;
  x?: number;
  y?: number;
};

type LinkDatum = d3.SimulationLinkDatum<NodeDatum> & {
  source: string | NodeDatum;
  target: string | NodeDatum;
  type: "propose" | "veto" | "consensus";
};

const nodesData: NodeDatum[] = [
  { id: "Proposer", group: "core" },
  { id: "Risk Manager", group: "risk" },
  { id: "News", group: "intel" },
  { id: "Macro", group: "intel" },
  { id: "Technical", group: "intel" },
  { id: "Sentiment", group: "intel" },
  { id: "Order Flow", group: "intel" },
  { id: "Reflection", group: "memory" }
];

const linksData: LinkDatum[] = [
  { source: "News", target: "Proposer", type: "propose" },
  { source: "Macro", target: "Proposer", type: "propose" },
  { source: "Technical", target: "Proposer", type: "propose" },
  { source: "Sentiment", target: "Proposer", type: "consensus" },
  { source: "Order Flow", target: "Proposer", type: "propose" },
  { source: "Proposer", target: "Risk Manager", type: "propose" },
  { source: "Risk Manager", target: "Proposer", type: "veto" },
  { source: "Reflection", target: "Proposer", type: "consensus" },
  { source: "Reflection", target: "Risk Manager", type: "consensus" }
];

export default function MultiAgentDialogueGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!containerRef.current || !svgRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = 300;

    const svg = d3.select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", [0, 0, width, height]);

    svg.selectAll("*").remove();

    // Create container group for zoom/pan
    const g = svg.append("g");

    // Copy data to avoid mutating original
    const nodes = nodesData.map(d => ({ ...d }));
    const links = linksData.map(d => ({ ...d }));

    const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d: any) => d.id).distance(80))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide().radius(30));

    // Defs for arrows and gradients
    const defs = svg.append("defs");
    
    const colors = {
      propose: "#3b82f6",  // Blue
      veto: "#f43f5e",     // Rose
      consensus: "#10b981" // Emerald
    };

    Object.entries(colors).forEach(([key, color]) => {
      defs.append("marker")
        .attr("id", `arrow-${key}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 25)
        .attr("refY", 0)
        .attr("markerWidth", 5)
        .attr("markerHeight", 5)
        .attr("orient", "auto")
        .append("path")
        .attr("fill", color)
        .attr("d", "M0,-5L10,0L0,5");
    });

    // Links
    const link = g.append("g")
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", d => colors[d.type as keyof typeof colors])
      .attr("stroke-width", 1.5)
      .attr("stroke-opacity", 0.6)
      .attr("marker-end", d => `url(#arrow-${d.type})`)
      .attr("class", "link-path");

    // Nodes
    const nodeGroup = g.append("g")
      .selectAll("g")
      .data(nodes)
      .join("g");

    nodeGroup.append("circle")
      .attr("r", 20)
      .attr("fill", "#1A1F2B")
      .attr("stroke", d => {
        if (d.group === "core") return "#indigo-400"; // not a hex, let's use actual hex
        if (d.group === "risk") return "#f43f5e";
        if (d.group === "memory") return "#a855f7";
        return "#38bdf8";
      })
      .attr("stroke-width", 2);

    nodeGroup.append("text")
      .text(d => d.id)
      .attr("x", 0)
      .attr("y", 30)
      .attr("text-anchor", "middle")
      .attr("fill", "#94a3b8")
      .style("font-size", "10px")
      .style("font-family", "monospace")
      .style("pointer-events", "none");

    const getNodeColorHex = (group: string) => {
        if (group === "core") return "#818cf8"; // indigo-400
        if (group === "risk") return "#fb7185"; // rose-400
        if (group === "memory") return "#c084fc"; // purple-400
        return "#7dd3fc"; // sky-400
    };

    nodeGroup.selectAll("circle")
      .attr("stroke", (d: any) => getNodeColorHex(d.group))

    // Inner icon or initial letter
    nodeGroup.append("text")
      .text(d => d.id.charAt(0))
      .attr("x", 0)
      .attr("y", 4)
      .attr("text-anchor", "middle")
      .attr("fill", (d: any) => getNodeColorHex(d.group))
      .style("font-size", "12px")
      .style("font-weight", "bold")
      .style("pointer-events", "none");

    simulation.on("tick", () => {
      link.attr("d", (d: any) => {
        const dx = d.target.x - d.source.x;
        const dy = d.target.y - d.source.y;
        const dr = Math.sqrt(dx * dx + dy * dy);
        // Add arcing to paths to prevent overlap
        return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,1 ${d.target.x},${d.target.y}`;
      });

      nodeGroup.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    // Message Animation Loop
    const animateMessages = () => {
      // Pick a random link
      const randomLinkIndex = Math.floor((Date.now() % 1000 / 1000) * links.length);
      const chosenLink = links[randomLinkIndex] as any;
      const type = chosenLink.type as keyof typeof colors;
      
      const messageCircle = g.append("circle")
        .attr("r", 4)
        .attr("fill", colors[type])
        .attr("filter", "drop-shadow(0 0 4px " + colors[type] + ")");

      messageCircle.transition()
        .duration(1500)
        .ease(d3.easeCubicInOut)
        .attrTween("transform", () => {
          return (t) => {
            // Very simple linear interpolation on arc, actually better to just move straight or along path
            // For true path following, we can select the arc path element
            const pathNode = svg.selectAll('.link-path').nodes()[randomLinkIndex] as SVGPathElement;
             if(pathNode) {
                 const length = pathNode.getTotalLength();
                 const point = pathNode.getPointAtLength(t * length);
                 return `translate(${point.x},${point.y})`;
             }
             return `translate(${chosenLink.source.x},${chosenLink.source.y})`;
          };
        })
        .on("end", () => {
          messageCircle.remove();
        });
        
      setTimeout(animateMessages, 800 + (Date.now() % 1000 / 1000) * 1200);
    };

    // Start sending multiple messages
    const timers = [
      setTimeout(animateMessages, 500),
      setTimeout(animateMessages, 1200),
      setTimeout(animateMessages, 2000)
    ];

    return () => {
      simulation.stop();
      timers.forEach(t => clearTimeout(t));
    };
  }, []);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
          <MessageSquareShare size={15} className="text-amber-400" />
          Multi-Agent Dialogue Graph
        </h3>
        <div className="flex gap-3 text-[10px] font-mono tracking-wide">
          <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-blue-500"></div>Propose</div>
          <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-emerald-500"></div>Consensus</div>
          <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-rose-500"></div>Veto</div>
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-2">
        D3 interactive simulation of real-time communication between agent nodes.
      </p>
      
      <div 
        ref={containerRef} 
        className="w-full relative rounded-lg border border-slate-800/50 bg-[#111822] overflow-hidden" 
        style={{ height: '300px' }}
      >
        {/* Subtle grid background */}
        <div className="absolute inset-0 z-0 opacity-10 pointer-events-none"
             style={{ backgroundImage: 'radial-gradient(#818cf8 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
        </div>
        <svg ref={svgRef} className="w-full h-full relative z-10" />
      </div>
    </div>
  );
}
