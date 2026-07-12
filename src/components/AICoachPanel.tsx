import React, { useState } from "react";
import { MessageSquare, X, CheckCircle, Circle, ChevronRight, HelpCircle, Search, Play } from "lucide-react";

export function AICoachPanel({ onClose }: { onClose?: () => void }) {
  const [activeTab, setActiveTab] = useState<"coach" | "checklist" | "search">("coach");
  const [checklist, setChecklist] = useState([
    { id: 1, text: "Connect broker", completed: true },
    { id: 2, text: "Configure AI providers", completed: true },
    { id: 3, text: "Configure news sources", completed: true },
    { id: 4, text: "Configure autonomous trading rules", completed: false },
    { id: 5, text: "Set risk limits", completed: false },
    { id: 6, text: "Set capital allocation", completed: false },
    { id: 7, text: "Start simulation", completed: false },
    { id: 8, text: "Review first AI recommendation", completed: false },
    { id: 9, text: "Enable autonomous trading", completed: false },
  ]);

  const [searchQuery, setSearchQuery] = useState("");

  const completedCount = checklist.filter(c => c.completed).length;

  return (
    <div className="fixed bottom-6 right-6 w-80 bg-[#1A1F2B] border border-indigo-500/50 shadow-[0_0_30px_rgba(99,102,241,0.15)] rounded-lg z-[90] overflow-hidden flex flex-col font-sans animate-fade-in">
      {/* Header */}
      <div className="bg-gradient-to-r from-indigo-900/50 to-[#1A1F2B] p-3 border-b border-indigo-500/30 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
            <MessageSquare size={14} />
          </div>
          <span className="text-sm font-bold text-white tracking-wide">AI Trading Coach</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={16} />
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800">
        <button onClick={() => setActiveTab("coach")} className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${activeTab === "coach" ? "text-indigo-400 border-b-2 border-indigo-500 bg-indigo-500/5" : "text-slate-500 hover:text-slate-300"}`}>
          Coach
        </button>
        <button onClick={() => setActiveTab("checklist")} className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${activeTab === "checklist" ? "text-indigo-400 border-b-2 border-indigo-500 bg-indigo-500/5" : "text-slate-500 hover:text-slate-300"}`}>
          Checklist
        </button>
        <button onClick={() => setActiveTab("search")} className={`flex-1 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors ${activeTab === "search" ? "text-indigo-400 border-b-2 border-indigo-500 bg-indigo-500/5" : "text-slate-500 hover:text-slate-300"}`}>
          Help
        </button>
      </div>

      {/* Content */}
      <div className="p-4 flex-1 overflow-y-auto max-h-[300px] custom-scrollbar">
        {activeTab === "coach" && (
          <div className="space-y-4">
            <div className="bg-[#0A0F16] border border-slate-800 rounded p-3 relative">
              <div className="absolute top-[-8px] left-4 bg-[#1A1F2B] px-1 text-[9px] font-mono text-indigo-400 font-bold tracking-widest">WHAT SHOULD I DO NEXT?</div>
              <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                Your broker is connected, but risk limits are not configured. Autonomous trading requires maximum daily loss limits to protect your capital.
              </p>
              <button className="mt-3 w-full py-1.5 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded text-xs font-bold transition-colors flex items-center justify-center gap-2">
                Configure Risk Limits <ChevronRight size={14} />
              </button>
            </div>
            
            <div className="bg-[#0A0F16] border border-slate-800 rounded p-3 relative">
              <div className="absolute top-[-8px] left-4 bg-[#1A1F2B] px-1 text-[9px] font-mono text-emerald-400 font-bold tracking-widest">TIP OF THE DAY</div>
              <p className="text-xs text-slate-300 mt-2 leading-relaxed">
                Calculation Engines provide raw signals, while AI Agents interpret them. Enable multiple agents to create a strong consensus debate before execution.
              </p>
            </div>
          </div>
        )}

        {activeTab === "checklist" && (
          <div>
            <div className="flex justify-between items-center mb-3">
              <span className="text-xs font-bold text-white">Setup Progress</span>
              <span className="text-xs font-mono text-indigo-400">{completedCount} of {checklist.length}</span>
            </div>
            <div className="w-full h-1.5 bg-slate-800 rounded-full mb-4 overflow-hidden">
              <div className="h-full bg-indigo-500 transition-all duration-500" style={{ width: `${(completedCount / checklist.length) * 100}%` }}></div>
            </div>
            <div className="space-y-2">
              {checklist.map(item => (
                <div key={item.id} className={`flex items-start gap-2 ${item.completed ? "opacity-50" : ""}`}>
                  <button className="mt-0.5 shrink-0" onClick={() => setChecklist(checklist.map(c => c.id === item.id ? { ...c, completed: !c.completed } : c))}>
                    {item.completed ? <CheckCircle size={14} className="text-emerald-400" /> : <Circle size={14} className="text-slate-500" />}
                  </button>
                  <span className={`text-xs ${item.completed ? "text-slate-500 line-through" : "text-slate-300"}`}>
                    {item.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "search" && (
          <div>
            <div className="relative mb-4">
              <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
              <input 
                type="text" 
                placeholder="Search tutorials, FAQs..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#0A0F16] border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-xs text-white outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
            <div className="space-y-2">
              <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Suggested Topics</h4>
              {[
                "How do I start autonomous trading?",
                "What is AI Confidence?",
                "How do calculation engines work?",
                "Why did the AI buy this stock?"
              ].filter(q => q.toLowerCase().includes(searchQuery.toLowerCase())).map((q, i) => (
                <button key={i} className="w-full text-left p-2 rounded bg-slate-800/50 hover:bg-slate-800 text-xs text-slate-300 transition-colors flex items-center justify-between group">
                  <span className="truncate">{q}</span>
                  <Play size={12} className="text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="bg-[#0A0F16] border-t border-slate-800 p-2 flex justify-between items-center">
        <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold ml-2">Learning Mode</span>
        <select className="bg-[#1A1F2B] border border-slate-700 text-xs text-indigo-400 font-bold rounded px-2 py-1 outline-none">
          <option>Beginner</option>
          <option>Intermediate</option>
          <option>Professional</option>
        </select>
      </div>
    </div>
  );
}
