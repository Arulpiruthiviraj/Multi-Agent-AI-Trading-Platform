/**
 * Stable React Flow node types for LiveTradeJourneyOverlay (reactflow #002).
 */
import React from 'react';
import { Handle, Position } from 'reactflow';

function JourneyNode({ data }: { data: any }) {
  return (
    <div className={`px-4 py-2 w-48 shadow-xl rounded-lg bg-[#111822] border-2 transition-all duration-300 ${data.active ? 'border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.4)] scale-105' : 'border-slate-800'}`}>
      <Handle type="target" position={Position.Top} className="w-0 h-0 border-none bg-transparent" />
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded ${data.active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-500'}`}>
          {data.icon}
        </div>
        <div>
          <div className="text-[10px] font-bold text-white uppercase tracking-widest leading-tight">{data.label}</div>
          <div className="text-[8px] text-slate-400 mt-0.5 max-w-xs overflow-hidden text-ellipsis whitespace-nowrap">{data.description || '...'}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="w-0 h-0 border-none bg-transparent" />
    </div>
  );
}

export { JourneyNode };
