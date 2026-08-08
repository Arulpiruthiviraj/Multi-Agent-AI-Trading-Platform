import React, { useState, useEffect } from "react";
import { BrainCircuit, Activity, Database, Clock, RefreshCw, AlertTriangle, Settings2, BarChart2, ActivitySquare } from "lucide-react";
import { ComposedChart, Line, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

export const KronosDashboard = () => {
  const [kronosStatus, setKronosStatus] = useState<any>(null);
  
  useEffect(() => {
    // Attempt to fetch real Kronos status
    fetch('/api/kronos/status')
      .then(res => res.json())
      .then(data => setKronosStatus(data))
      .catch(() => setKronosStatus({ status: 'UNAVAILABLE' }));
  }, []);

  const isUnavailable = kronosStatus?.status === 'UNAVAILABLE';
  const chartData: any[] = []; // Real data should be loaded from backend

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <h2 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800 pb-4 mb-4">
          <BrainCircuit size={18} className="text-indigo-400" />
          Kronos Local Inference Engine
        </h2>

        {isUnavailable ? (
          <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded text-rose-400 flex items-start gap-3">
            <AlertTriangle className="shrink-0 mt-0.5" size={16} />
            <div>
              <p className="font-medium text-sm">Warning: KRONOS_UNAVAILABLE</p>
              <p className="text-xs text-rose-400/80 mt-1">
                The Kronos prediction engine requires a valid Python/PyTorch environment. 
                Trading continues using remaining evidence sources (Technical, Macro, Fundamental, News).
              </p>
            </div>
          </div>
        ) : (
          <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded text-emerald-400 flex items-start gap-3">
             <RefreshCw className="shrink-0 mt-0.5 animate-spin" size={16} />
             <div>
              <p className="font-medium text-sm">Status: {kronosStatus?.status || 'Loading...'}</p>
             </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
           <div className="bg-[#111822] border border-slate-800 rounded p-4">
              <div className="text-xs text-slate-500 mb-1 flex items-center gap-1"><Database size={12}/> Model Version</div>
              <div className="text-sm font-mono text-slate-300">{kronosStatus?.version || '-'}</div>
           </div>
           <div className="bg-[#111822] border border-slate-800 rounded p-4">
              <div className="text-xs text-slate-500 mb-1 flex items-center gap-1"><Activity size={12}/> GPU Usage</div>
              <div className="text-sm font-mono text-slate-300">{kronosStatus?.gpuUsage || '-'}</div>
           </div>
           <div className="bg-[#111822] border border-slate-800 rounded p-4">
              <div className="text-xs text-slate-500 mb-1 flex items-center gap-1"><Database size={12}/> Memory Usage</div>
              <div className="text-sm font-mono text-slate-300">{kronosStatus?.memoryUsage || '-'}</div>
           </div>
           <div className="bg-[#111822] border border-slate-800 rounded p-4">
              <div className="text-xs text-slate-500 mb-1 flex items-center gap-1"><Clock size={12}/> Inference Time</div>
              <div className="text-sm font-mono text-slate-300">{kronosStatus?.inferenceTime || '-'}</div>
           </div>
        </div>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
             <h2 className="text-sm font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
               <Settings2 size={16} className="text-slate-400" />
               Engine Configuration
             </h2>
             <div className="space-y-4">
                <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-400">Forecast Horizon</span>
                    <span className="text-xs text-slate-300">--</span>
                </div>
                <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-400">Timeframes</span>
                    <span className="text-xs font-mono text-indigo-400">--</span>
                </div>
                <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-400">Confidence Threshold</span>
                    <span className="text-xs font-mono text-emerald-400">--</span>
                </div>
                <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-400">Multi-Asset Batch Mode</span>
                    <span className="text-xs font-mono text-emerald-400 text-right uppercase">--</span>
                </div>
             </div>
          </div>

          <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
             <h2 className="text-sm font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
               <BarChart2 size={16} className="text-emerald-400" />
               Historical Performance
             </h2>
             <div className="space-y-4">
                <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-400">Directional Accuracy</span>
                    <span className="text-sm font-mono text-emerald-400">DATA_UNAVAILABLE</span>
                </div>
                <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-400">MAE</span>
                    <span className="text-sm font-mono text-slate-300">DATA_UNAVAILABLE</span>
                </div>
                <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-400">RMSE</span>
                    <span className="text-sm font-mono text-slate-300">DATA_UNAVAILABLE</span>
                </div>
                <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-400">MAPE</span>
                    <span className="text-sm font-mono text-slate-300">DATA_UNAVAILABLE</span>
                </div>
             </div>
          </div>
      </div>

      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <h2 className="text-sm font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
          <ActivitySquare size={16} className="text-indigo-400" />
          Kronos Volatility & Price Forecast (ATR Bands)
        </h2>
        
        <div className="h-72 w-full mt-4 flex items-center justify-center border border-dashed border-slate-700 bg-[#111822] rounded">
           <span className="text-sm text-slate-500 font-mono">DATA_UNAVAILABLE</span>
        </div>
      </div>
    </div>
  );
};
