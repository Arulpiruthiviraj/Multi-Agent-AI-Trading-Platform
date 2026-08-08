/**
 * ==========================================================
 * Module:
 * GlobalSearch.tsx
 *
 * Purpose:
 * Core implementation and logic for the GlobalSearch.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for GlobalSearchx
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

import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Search, 
  Cpu, 
  Layers, 
  Activity, 
  Wallet, 
  Users, 
  Database, 
  Shield, 
  Zap, 
  List, 
  BookOpen, 
  Settings,
  TrendingUp,
  X,
  Command,
  ArrowRight
} from "lucide-react";

interface SearchItem {
  id: string;
  title: string;
  description: string;
  category: "Navigation" | "Agent" | "Documentation" | "Symbol";
  icon: React.ReactNode;
  action: () => void;
}

interface GlobalSearchProps {
  isOpen: boolean;
  onClose: () => void;
  setActiveTab: (tab: any) => void;
}

const GlobalSearch: React.FC<GlobalSearchProps> = ({ isOpen, onClose, setActiveTab }) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const searchItems: SearchItem[] = [
    // Navigation
    { id: "nav-command", title: "Autonomous Trading", description: "Master control center for AI trading bot", category: "Navigation", icon: <Cpu size={16} />, action: () => setActiveTab("command") },
    { id: "nav-arena", title: "Trading Arena", description: "On-demand deep analysis of specific symbols", category: "Navigation", icon: <Layers size={16} />, action: () => setActiveTab("arena") },
    { id: "nav-scanner", title: "Strategy Scanner", description: "Continuous market pattern discovery", category: "Navigation", icon: <Activity size={16} />, action: () => setActiveTab("scanner") },
    { id: "nav-portfolio", title: "Portfolio & Holdings", description: "Real-time view of Alpaca positions", category: "Navigation", icon: <Wallet size={16} />, action: () => setActiveTab("portfolio") },
    { id: "nav-agents", title: "Agent Performance", description: "Swarm intelligence network health", category: "Navigation", icon: <Users size={16} />, action: () => setActiveTab("agents") },
    { id: "nav-memory", title: "Memory & Reflection", description: "Historical decision mapping and rules", category: "Navigation", icon: <Database size={16} />, action: () => setActiveTab("memory") },
    { id: "nav-audit", title: "Audit Logs", description: "Strict ledger of all executed trades", category: "Navigation", icon: <Shield size={16} />, action: () => setActiveTab("audit") },
    { id: "nav-opportunities", title: "Opportunity Feed", description: "Live high-conviction trade setups", category: "Navigation", icon: <Zap size={16} />, action: () => setActiveTab("opportunities") },
    { id: "nav-learning", title: "Learning & Evolution", description: "Backtest engines and strategy tuning", category: "Navigation", icon: <TrendingUp size={16} />, action: () => setActiveTab("learning") },
    { id: "nav-activity", title: "Activity Logs", description: "System telemetry and agent thinking", category: "Navigation", icon: <List size={16} />, action: () => setActiveTab("activity") },
    { id: "nav-docs", title: "System Documentation", description: "Architecture and usage guidelines", category: "Navigation", icon: <BookOpen size={16} />, action: () => setActiveTab("documentation") },
    { id: "nav-settings", title: "Terminal Settings", description: "API keys and provider configuration", category: "Navigation", icon: <Settings size={16} />, action: () => setActiveTab("settings") },

    // Agents
    { id: "agent-news", title: "NewsAgent (NLP)", description: "Sentiment and catalyst analysis agent", category: "Agent", icon: <Users size={16} className="text-blue-400" />, action: () => { setActiveTab("agents"); } },
    { id: "agent-macro", title: "MacroAgent (Quant)", description: "Economic regime identification agent", category: "Agent", icon: <Users size={16} className="text-purple-400" />, action: () => { setActiveTab("agents"); } },
    { id: "agent-tech", title: "TechnicalAgent (TA)", description: "Chart structure and pattern recognition", category: "Agent", icon: <Users size={16} className="text-emerald-400" />, action: () => { setActiveTab("agents"); } },
    { id: "agent-sentiment", title: "SentimentAgent", description: "Social media velocity and hype tracking", category: "Agent", icon: <Users size={16} className="text-amber-400" />, action: () => { setActiveTab("agents"); } },

    // Documentation Sections
    { id: "doc-overview", title: "Doc: System Overview", description: "Introduction to Argus multi-agent model", category: "Documentation", icon: <BookOpen size={16} className="text-slate-400" />, action: () => { setActiveTab("documentation"); } },
    { id: "doc-setup", title: "Doc: System Setup", description: "Instructions for laptop installation and keys", category: "Documentation", icon: <BookOpen size={16} className="text-slate-400" />, action: () => { setActiveTab("documentation"); } },
    { id: "doc-workflow", title: "Doc: Trading Workflow", description: "Autonomous cycle: Scan -> Consensus -> Risk", category: "Documentation", icon: <BookOpen size={16} className="text-slate-400" />, action: () => { setActiveTab("documentation"); } },

    // Symbols
    { id: "sym-tsla", title: "TSLA", description: "Tesla, Inc. - Common Stock", category: "Symbol", icon: <TrendingUp size={16} className="text-emerald-400" />, action: () => { setActiveTab("arena"); } },
    { id: "sym-aapl", title: "AAPL", description: "Apple Inc. - Common Stock", category: "Symbol", icon: <TrendingUp size={16} className="text-emerald-400" />, action: () => { setActiveTab("arena"); } },
    { id: "sym-nvda", title: "NVDA", description: "NVIDIA Corporation - Common Stock", category: "Symbol", icon: <TrendingUp size={16} className="text-emerald-400" />, action: () => { setActiveTab("arena"); } },
    { id: "sym-btc", title: "BTC/USD", description: "Bitcoin USD - Crypto", category: "Symbol", icon: <TrendingUp size={16} className="text-amber-400" />, action: () => { setActiveTab("arena"); } },
  ];

  const filteredItems = query.trim() === "" 
    ? searchItems.slice(0, 5) 
    : searchItems.filter(item => 
        item.title.toLowerCase().includes(query.toLowerCase()) || 
        item.description.toLowerCase().includes(query.toLowerCase()) ||
        item.category.toLowerCase().includes(query.toLowerCase())
      );

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filteredItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filteredItems.length) % filteredItems.length);
      } else if (e.key === "Enter") {
        if (filteredItems[selectedIndex]) {
          filteredItems[selectedIndex].action();
          onClose();
        }
      } else if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, filteredItems, selectedIndex, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm"
          />
          
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            className="relative w-full max-w-2xl bg-[#1A1F2B] border border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
          >
            <div className="flex items-center px-4 py-3.5 border-b border-slate-800 bg-[#111822]">
              <Search className="text-slate-500 mr-3" size={20} />
              <input
                ref={inputRef}
                type="text"
                placeholder="Search symbols, agents, or documentation..."
                className="flex-1 bg-transparent border-none outline-none text-white text-base placeholder:text-slate-600"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
              />
              <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-slate-500 uppercase tracking-widest">
                <Command size={10} />
                <span>K</span>
              </div>
              <button 
                onClick={onClose}
                className="ml-3 p-1.5 hover:bg-slate-800 text-slate-500 hover:text-white rounded-lg transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="max-h-[400px] overflow-y-auto py-2 scrollbar-hide">
              {filteredItems.length > 0 ? (
                <div className="flex flex-col">
                  {filteredItems.map((item, index) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        item.action();
                        onClose();
                      }}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={`flex items-center gap-4 px-4 py-3 text-left transition-colors ${
                        selectedIndex === index ? "bg-indigo-500/10 border-l-2 border-indigo-500" : "border-l-2 border-transparent"
                      }`}
                    >
                      <div className={`p-2 rounded-lg ${selectedIndex === index ? "bg-indigo-500/20 text-indigo-400" : "bg-slate-800/50 text-slate-500"}`}>
                        {item.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-bold ${selectedIndex === index ? "text-white" : "text-slate-300"}`}>
                            {item.title}
                          </span>
                          <span className="text-[10px] uppercase font-mono tracking-widest text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                            {item.category}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 truncate mt-0.5">
                          {item.description}
                        </p>
                      </div>
                      {selectedIndex === index && (
                        <motion.div
                          initial={{ x: -5, opacity: 0 }}
                          animate={{ x: 0, opacity: 1 }}
                        >
                          <ArrowRight size={16} className="text-indigo-400" />
                        </motion.div>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="py-12 text-center flex flex-col items-center">
                  <div className="bg-slate-900 p-4 rounded-full border border-slate-800 mb-4">
                    <Search size={32} className="text-slate-600" />
                  </div>
                  <p className="text-slate-400 font-medium">No results found for "{query}"</p>
                  <p className="text-xs text-slate-600 mt-1">Try searching for "agents", "documentation", or "scanner"</p>
                </div>
              )}
            </div>

            <div className="px-4 py-2 border-t border-slate-800 bg-[#111822] flex items-center justify-between text-[10px] font-mono text-slate-500 uppercase tracking-widest">
              <div className="flex gap-4">
                <span className="flex items-center gap-1"><span className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-300">↑↓</span> Navigate</span>
                <span className="flex items-center gap-1"><span className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-300">↵</span> Select</span>
              </div>
              <span className="flex items-center gap-1"><span className="px-1.5 py-0.5 bg-slate-800 rounded text-slate-300">ESC</span> Close</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default GlobalSearch;
