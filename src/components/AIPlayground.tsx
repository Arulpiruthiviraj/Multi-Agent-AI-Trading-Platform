/**
 * ==========================================================
 * Module:
 * AIPlayground.tsx
 *
 * Purpose:
 * Core implementation and logic for the AIPlayground.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AIPlaygroundx
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

import React, { useState } from 'react';
import { Play, SplitSquareHorizontal, Zap, DollarSign, BrainCircuit, Code, Clock } from 'lucide-react';

export default function AIPlayground() {
  const [prompt, setPrompt] = useState("Evaluate the following market conditions: NVDA breaking out of a 2-week consolidation, volume is 1.5x average, RSI is 68. Provide a trading decision (BUY/SELL/HOLD), confidence score (0-100), and reasoning in JSON format.");
  
  const [isRunning, setIsRunning] = useState(false);
  
  const [modelA, setModelA] = useState('Google Gemini 1.5 Pro');
  const [modelB, setModelB] = useState('DeepSeek Coder V2');

  const [results, setResults] = useState<any>(null);

  const handleRun = () => {
    setIsRunning(true);
    setResults(null);
    
    setTimeout(() => {
      setResults({
        modelA: {
          latency: 480,
          cost: 0.0012,
          tokens: 154,
          reasoning: "The model correctly identified the bullish breakout with high volume as a strong continuation signal. It kept the confidence bounded since RSI is nearing 70 but not strictly overbought.",
          response: '{\n  "decision": "BUY",\n  "confidence": 85,\n  "reasoning": "NVDA is exhibiting a classic high-volume breakout from consolidation. With RSI at 68, there is still room for upside before hitting extreme overbought conditions."\n}'
        },
        modelB: {
          latency: 320,
          cost: 0.0004,
          tokens: 148,
          reasoning: "DeepSeek provided a highly structured response but was slightly more conservative on the confidence score.",
          response: '{\n  "decision": "BUY",\n  "confidence": 78,\n  "reasoning": "Breakout confirmed by 1.5x relative volume. RSI 68 indicates strong momentum but approaches overbought territory. Favorable risk/reward for a momentum long."\n}'
        }
      });
      setIsRunning(false);
    }, 1500);
  };

  return (
    <div className="flex flex-col gap-6 font-mono text-slate-200 animate-fade-in">
      <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg border-l-4 border-l-purple-500">
        <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest mb-4 flex items-center gap-2">
          <SplitSquareHorizontal size={14} className="text-purple-500" /> Multi-Model Playground & A/B Testing
        </h3>
        <p className="text-[10px] text-slate-400 uppercase tracking-widest mb-4">
          Test prompts and compare multiple AI models side-by-side for latency, reasoning quality, and JSON validity.
        </p>

        {/* Prompt Input */}
        <div className="mb-6">
          <label className="text-[10px] text-slate-500 uppercase tracking-widest mb-2 block">System Prompt / Query</label>
          <textarea 
            className="w-full h-24 bg-[#0A0F16] border border-slate-700 text-xs text-slate-300 p-3 rounded outline-none focus:border-purple-500 font-mono resize-none"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        {/* Action Bar */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-6 bg-[#0A0F16] p-3 rounded border border-slate-800">
          <div className="flex items-center gap-4 w-full md:w-auto">
            <div className="flex-1 md:flex-none">
               <label className="text-[9px] text-slate-500 uppercase tracking-widest mb-1 block">Model A</label>
               <select 
                 className="w-full bg-[#1A1F2B] border border-slate-700 text-[10px] font-bold text-white p-2 rounded outline-none"
                 value={modelA}
                 onChange={(e) => setModelA(e.target.value)}
               >
                 <option>Google Gemini 1.5 Pro</option>
                 <option>OpenAI GPT-4o</option>
                 <option>Anthropic Claude 3.5 Sonnet</option>
                 <option>Ollama Llama 3</option>
               </select>
            </div>
            <div className="text-slate-600 font-bold px-2">VS</div>
            <div className="flex-1 md:flex-none">
               <label className="text-[9px] text-slate-500 uppercase tracking-widest mb-1 block">Model B</label>
               <select 
                 className="w-full bg-[#1A1F2B] border border-slate-700 text-[10px] font-bold text-white p-2 rounded outline-none"
                 value={modelB}
                 onChange={(e) => setModelB(e.target.value)}
               >
                 <option>DeepSeek Coder V2</option>
                 <option>Mistral Large</option>
                 <option>Groq Llama 3 70B</option>
                 <option>Anthropic Claude 3 Haiku</option>
               </select>
            </div>
          </div>
          
          <button 
            onClick={handleRun}
            disabled={isRunning}
            className={`flex items-center gap-2 px-6 py-2 rounded text-xs font-bold uppercase tracking-widest transition-all ${isRunning ? 'bg-slate-700 text-slate-400' : 'bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_15px_rgba(147,51,234,0.3)]'}`}
          >
            {isRunning ? <Zap size={14} className="animate-pulse" /> : <Play size={14} />} 
            {isRunning ? 'Benchmarking...' : 'Run Comparison'}
          </button>
        </div>

        {/* Results */}
        {results && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 animate-fade-in">
            {/* Model A Results */}
            <div className="bg-[#0A0F16] border border-slate-800 rounded-lg overflow-hidden">
               <div className="bg-[#1A1F2B] p-3 border-b border-slate-800 flex justify-between items-center">
                 <span className="text-xs font-bold text-white">{modelA}</span>
                 <div className="flex gap-3 text-[9px] font-bold uppercase tracking-widest">
                   <span className="flex items-center gap-1 text-emerald-400"><Clock size={10} /> {results.modelA.latency}ms</span>
                   <span className="flex items-center gap-1 text-amber-400"><DollarSign size={10} /> ${results.modelA.cost}</span>
                 </div>
               </div>
               <div className="p-4 flex flex-col gap-4">
                 <div>
                   <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1"><Code size={10} /> Raw JSON Output</div>
                   <pre className="bg-[#05080c] p-3 rounded border border-slate-800 text-[10px] text-emerald-400 overflow-x-auto whitespace-pre-wrap break-all">
                     {results.modelA.response}
                   </pre>
                 </div>
                 <div>
                   <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1"><BrainCircuit size={10} /> Evaluation</div>
                   <div className="text-xs text-slate-300 leading-relaxed border-l-2 border-indigo-500 pl-3">
                     {results.modelA.reasoning}
                   </div>
                 </div>
               </div>
            </div>

            {/* Model B Results */}
            <div className="bg-[#0A0F16] border border-slate-800 rounded-lg overflow-hidden">
               <div className="bg-[#1A1F2B] p-3 border-b border-slate-800 flex justify-between items-center">
                 <span className="text-xs font-bold text-white">{modelB}</span>
                 <div className="flex gap-3 text-[9px] font-bold uppercase tracking-widest">
                   <span className="flex items-center gap-1 text-emerald-400"><Clock size={10} /> {results.modelB.latency}ms</span>
                   <span className="flex items-center gap-1 text-amber-400"><DollarSign size={10} /> ${results.modelB.cost}</span>
                 </div>
               </div>
               <div className="p-4 flex flex-col gap-4">
                 <div>
                   <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1"><Code size={10} /> Raw JSON Output</div>
                   <pre className="bg-[#05080c] p-3 rounded border border-slate-800 text-[10px] text-sky-400 overflow-x-auto whitespace-pre-wrap break-all">
                     {results.modelB.response}
                   </pre>
                 </div>
                 <div>
                   <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1"><BrainCircuit size={10} /> Evaluation</div>
                   <div className="text-xs text-slate-300 leading-relaxed border-l-2 border-sky-500 pl-3">
                     {results.modelB.reasoning}
                   </div>
                 </div>
               </div>
            </div>
          </div>
        )}

      </div>

      {/* Prompt Versioning & Response Replay */}
      <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg border-l-4 border-l-emerald-500 mt-6">
        <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest mb-4 flex items-center gap-2">
          <Clock size={14} className="text-emerald-500" /> Prompt Versioning & Replay Engine
        </h3>
        <p className="text-[10px] text-slate-400 uppercase tracking-widest mb-4">
          Store, version, and replay historical AI prompt decisions.
        </p>
        
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] text-slate-500 uppercase tracking-widest">
                <th className="pb-3 font-medium">Version</th>
                <th className="pb-3 font-medium">Agent</th>
                <th className="pb-3 font-medium">Prompt Snippet</th>
                <th className="pb-3 font-medium">Tokens</th>
                <th className="pb-3 font-medium">Cost</th>
                <th className="pb-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                <td className="py-4 text-xs font-bold text-slate-300">v1.4.2</td>
                <td className="py-4 text-[10px] text-slate-400 uppercase tracking-wider">Risk Manager</td>
                <td className="py-4 text-xs text-slate-300 max-w-xs truncate">"Evaluate this trade against daily loss cap of $500. Current drawdown..."</td>
                <td className="py-4 text-xs font-bold text-slate-300">842</td>
                <td className="py-4 text-xs font-bold text-slate-300">$0.001</td>
                <td className="py-4 flex justify-end gap-3 text-slate-500">
                  <button className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-sky-400 rounded text-[10px] font-bold uppercase transition-colors">Replay</button>
                  <button className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-400 rounded text-[10px] font-bold uppercase transition-colors">Rollback</button>
                </td>
              </tr>
              <tr className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                <td className="py-4 text-xs font-bold text-slate-300">v1.4.1</td>
                <td className="py-4 text-[10px] text-slate-400 uppercase tracking-wider">Risk Manager</td>
                <td className="py-4 text-xs text-slate-300 max-w-xs truncate">"Check risk limits for this trade..."</td>
                <td className="py-4 text-xs font-bold text-slate-300">312</td>
                <td className="py-4 text-xs font-bold text-slate-300">$0.0005</td>
                <td className="py-4 flex justify-end gap-3 text-slate-500">
                  <button className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-sky-400 rounded text-[10px] font-bold uppercase transition-colors">Replay</button>
                  <button className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-400 rounded text-[10px] font-bold uppercase transition-colors">Rollback</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
