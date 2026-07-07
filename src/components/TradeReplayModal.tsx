import React, { useState, useEffect } from 'react';
import { X, Play, Pause, SkipBack, FastForward, Activity, BrainCircuit, BarChart2 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

/**
 * TradeReplayModal Component
 * 
 * Provides an interactive UI to replay the exact multi-agent context and market
 * conditions leading up to and immediately following a specific historical trade execution.
 * 
 * @param trade The specific trade object selected from the Historical Ledger.
 * @param onClose Callback function to close the modal.
 */
export default function TradeReplayModal({ trade, onClose }: { trade: any, onClose: () => void }) {
  // State to track whether the automated timeline playback is currently active
  const [isPlaying, setIsPlaying] = useState(false);
  
  // State to track the current position (index) of the replay timeline
  const [timelineIndex, setTimelineIndex] = useState(0);

  /**
   * Hardcoded simulation timeline steps representing the chronological actions 
   * taken by the multi-agent system. Each step includes a timestamp, the active phase,
   * an agent log message, a sentiment indicator, and a price representation.
   */
  const timelineSteps = [
    { time: "-5m", phase: "Market Scanning", msg: `Deep Research agent running macro sentiment analysis for ${trade.symbol}...`, sentiment: "NEUTRAL", price: 100 },
    { time: "-4m", phase: "Research Output", msg: `Research Agent graded ${trade.symbol} as BULLISH (Score: 0.65).`, sentiment: "BULLISH", price: 100.5 },
    { time: "-3m", phase: "Proposer Evaluation", msg: `Proposer suggests ${trade.decision} on ${trade.symbol} (conf: 88%).`, sentiment: "BULLISH", price: 101.2 },
    { time: "-2m", phase: "Risk Management", msg: `Risk Manager reviewing ${trade.decision} proposal. Checking size and constraints.`, sentiment: "BULLISH", price: 101.5 },
    { time: "-1m", phase: "Execution Routing", msg: `Execution Agent structured a MARKET order (Max Slip: 1.0%).`, sentiment: "BULLISH", price: 102.1 },
    // isExecution flag indicates the exact moment the trade order was submitted
    { time: "0m", phase: "EXECUTION", msg: `Executed ${trade.decision} on ${trade.symbol}.`, sentiment: "BULLISH", price: 102.5, isExecution: true },
    { time: "+1m", phase: "Post-Trade Tracking", msg: `Monitoring position. Price tracking nominal trajectory.`, sentiment: "BULLISH", price: 103.0 },
    { time: "+2m", phase: "Post-Trade Tracking", msg: `Volatility detected, stop-losses trailing.`, sentiment: "NEUTRAL", price: 101.8 },
    { time: "+3m", phase: "Post-Trade Tracking", msg: `Position closed. Outcome: ${trade.outcome}`, sentiment: "NEUTRAL", price: 103.5 },
  ];

  // Determine if the selected trade was profitable based on the presence of '+'
  const isWin = trade.outcome.includes("+");
  
  // Base price randomization to give the mock chart varied Y-axis values
  const basePrice = 150 + Math.random() * 100;
  
  /**
   * Generates mock price data for the AreaChart.
   * Modifies the trajectory to visually reflect whether the trade was a win or loss.
   */
  const chartData = timelineSteps.map((step, i) => {
    // Generate a curve modifier: trends upward by default after the middle point
    let mod = (i - 5) * 1.5;
    
    // Reverse the direction if it was a SELL trade (short position)
    if (trade.decision === "SELL") mod = -mod;
    
    // Reverse the direction if the trade was a loss
    if (!isWin) mod = -mod;
    
    return {
      time: step.time, // Timeline label (e.g., "-5m")
      // Calculate final price: Add some randomized noise, and apply the trend modifier after the execution point (i >= 5)
      price: basePrice + (i < 5 ? (Math.random() * 2 - 1) : mod + (Math.random() * 2 - 1))
    };
  });

  /**
   * Effect hook to handle the automatic playback progression.
   * If `isPlaying` is true, it increments the timelineIndex every 1.5 seconds.
   */
  useEffect(() => {
    let interval: any;
    if (isPlaying) {
      interval = setInterval(() => {
        setTimelineIndex(prev => {
          // Stop playing if we reach the end of the timeline steps
          if (prev >= timelineSteps.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          // Otherwise, move to the next step
          return prev + 1;
        });
      }, 1500); // 1.5 second delay per step
    }
    
    // Cleanup interval on unmount or when dependencies change
    return () => clearInterval(interval);
  }, [isPlaying, timelineSteps.length]);

  // Extract the specific data for the currently active timeline step
  const currentStep = timelineSteps[timelineIndex];

  return (
    // Modal Backdrop overlay: Dark, semi-transparent blur
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      
      {/* Main Modal Container */}
      <div className="bg-[#0A0F16] border border-slate-800 rounded-lg w-full max-w-4xl shadow-2xl overflow-hidden animate-fade-in relative flex flex-col font-mono">
        
        {/* Modal Header */}
        <div className="bg-slate-900 border-b border-slate-800 p-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            {/* Header Icon */}
            <div className="bg-indigo-500/20 p-2 rounded text-indigo-400">
              <Activity size={18} />
            </div>
            {/* Header Text */}
            <div>
              <h2 className="text-white font-bold tracking-widest uppercase text-sm">Trade Replay: {trade.symbol}</h2>
              <p className="text-slate-500 text-[10px]">Playback of Agent Context & Market Data on {trade.date}</p>
            </div>
          </div>
          {/* Close Button */}
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Modal Body Content */}
        <div className="p-6 flex flex-col gap-6">
          
          {/* Top Panel: Contains the Recharts Graph and the Agent Log */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* Left Panel: Market Context Graph */}
            <div className="bg-[#111822] border border-slate-800 rounded p-4 flex flex-col">
              <h3 className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-4 flex items-center gap-2">
                <BarChart2 size={12} className="text-sky-400" />
                Market Context
              </h3>
              <div className="h-40 w-full relative">
                {/* Visual indicator (pulsing border) shown only exactly during the EXECUTION step */}
                {currentStep.isExecution && (
                   <div className="absolute inset-0 border-2 border-emerald-500/50 rounded pointer-events-none animate-pulse z-10" />
                )}
                
                {/* Recharts AreaChart to plot the simulated price progression up to the current index */}
                <ResponsiveContainer width="100%" height="100%">
                  {/* Slice the chartData array so it only draws the chart up to the current timeline step */}
                  <AreaChart data={chartData.slice(0, timelineIndex + 1)}>
                    {/* Define gradient definitions for the Area fill color */}
                    <defs>
                      <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#38bdf8" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="time" hide />
                    {/* Dynamically adjust Y-Axis domain slightly above and below the min/max of the generated data */}
                    <YAxis hide domain={['dataMin - 5', 'dataMax + 5']} />
                    {/* Tooltip rendering configuration */}
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#111822', borderColor: '#1e293b', fontSize: '10px' }}
                      itemStyle={{ color: '#38bdf8' }}
                    />
                    {/* The area path itself. Uses 'stepAfter' for a blocky, technical appearance. No animation for instant updates. */}
                    <Area type="stepAfter" dataKey="price" stroke="#38bdf8" fillOpacity={1} fill="url(#colorPrice)" isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Right Panel: Agent Memory/State Log */}
            <div className="bg-[#111822] border border-slate-800 rounded p-4 flex flex-col justify-between">
              <div>
                <h3 className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-4 flex items-center gap-2">
                  <BrainCircuit size={12} className="text-indigo-400" />
                  Agent Internal State
                </h3>
                
                {/* Display Current Phase */}
                <div className="flex justify-between items-center mb-2 border-b border-slate-800/50 pb-2">
                   <span className="text-[10px] text-slate-500">Phase:</span>
                   <span className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">{currentStep.phase}</span>
                </div>
                
                {/* Display Current Sentiment with dynamic coloring */}
                <div className="flex justify-between items-center mb-2 border-b border-slate-800/50 pb-2">
                   <span className="text-[10px] text-slate-500">Sentiment:</span>
                   <span className={`text-[10px] font-bold uppercase tracking-wider ${currentStep.sentiment === 'BULLISH' ? 'text-emerald-400' : currentStep.sentiment === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'}`}>{currentStep.sentiment}</span>
                </div>
              </div>
              
              {/* Box displaying the actual string message/thought log of the agent for this specific step */}
              <div className="bg-[#0A0F16] border border-slate-800 p-3 rounded text-[11px] text-slate-300 min-h-[60px] flex items-center">
                {currentStep.msg}
              </div>
            </div>
          </div>

          {/* Bottom Panel: Timeline Slider & Controls */}
          <div className="bg-[#111822] border border-slate-800 rounded p-4 flex flex-col gap-4">
             {/* Transport Controls (Reset, Play/Pause, Skip to End) */}
             <div className="flex justify-between items-center">
                
                {/* Reset Button: Sets timeline to beginning and stops playback */}
                <button 
                  onClick={() => { setTimelineIndex(0); setIsPlaying(false); }}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors"
                >
                  <SkipBack size={14} />
                </button>
                
                {/* Play/Pause Button: Toggles playback state and dynamically changes styling */}
                <button 
                  onClick={() => setIsPlaying(!isPlaying)}
                  className={`px-6 py-2 flex items-center gap-2 rounded font-bold tracking-widest uppercase text-[10px] transition-colors ${isPlaying ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50 hover:bg-amber-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500/30'}`}
                >
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                  {isPlaying ? "Pause" : "Play Replay"}
                </button>
                
                {/* Skip to End Button: Sets timeline to the last step and stops playback */}
                <button 
                  onClick={() => { setTimelineIndex(timelineSteps.length - 1); setIsPlaying(false); }}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors"
                >
                  <FastForward size={14} />
                </button>
             </div>

             {/* Interactive Timeline Range Slider */}
             <div className="relative pt-4 pb-2">
                <input 
                  type="range" 
                  min="0" 
                  max={timelineSteps.length - 1} 
                  value={timelineIndex} 
                  onChange={(e) => {
                    // Update index based on manual slider dragging
                    setTimelineIndex(parseInt(e.target.value));
                    // Stop automatic playback if user manually seeks
                    setIsPlaying(false);
                  }}
                  className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
                
                {/* Labels mapping out the individual timestamps across the slider track */}
                <div className="flex justify-between mt-2 px-1">
                   {timelineSteps.map((step, i) => (
                     <span key={i} className={`text-[8px] uppercase tracking-widest ${i === timelineIndex ? 'text-indigo-400 font-bold' : step.isExecution ? 'text-emerald-500 font-bold' : 'text-slate-600'}`}>
                        {step.time}
                     </span>
                   ))}
                </div>
             </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}
