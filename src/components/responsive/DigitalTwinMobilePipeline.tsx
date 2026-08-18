import React from 'react';
import type { Node } from 'reactflow';
import { ChevronDown } from 'lucide-react';

/** Vertical pipeline node order for phone layouts (<768px). */
export const MOBILE_PIPELINE_ORDER = [
  'market-data-worker',
  'news-providers',
  'technical-engine',
  'news-agent',
  'fundamental-agent',
  'macro-agent',
  'quant-engine',
  'kronos-forecast',
  'portfolio-monitor',
  'finbert-model',
  'ollama-llm',
  'paid-llm-pool',
  'chief-trader',
  'risk-manager',
  'capital-guard',
  'order-management',
  'learning-engine',
] as const;

type DigitalTwinMobilePipelineProps = {
  nodes: Node[];
  onSelectNode: (id: string) => void;
};

export function DigitalTwinMobilePipeline({ nodes, onSelectNode }: DigitalTwinMobilePipelineProps) {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="flex md:hidden flex-col gap-0 py-2 argus-scroll-touch overflow-y-auto max-h-[520px]">
      {MOBILE_PIPELINE_ORDER.map((id, i) => {
        const node = byId.get(id);
        if (!node) return null;
        const status = String(node.data?.status ?? 'IDLE');
        const active = status !== 'IDLE';
        const statusCls =
          status === 'FAIL' ? 'border-rose-400 text-rose-400'
            : status === 'SUCCESS' ? 'border-emerald-400 text-emerald-400'
              : active ? 'border-cyan-500/50 text-cyan-300'
                : 'border-slate-800 text-slate-500';
        return (
          <React.Fragment key={id}>
            <button
              type="button"
              onClick={() => onSelectNode(id)}
              className={`argus-touch-target w-full text-left flex items-center gap-3 p-3 rounded-lg border bg-[#0A0F16] ${statusCls} transition-colors`}
            >
              <div className="shrink-0 w-8 h-8 rounded-lg bg-slate-800/80 flex items-center justify-center text-slate-300">
                {node.data?.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-bold text-white uppercase tracking-widest truncate">
                  {String(node.data?.label ?? id)}
                </div>
                <div className="text-[8px] font-mono text-slate-500 truncate">{String(node.data?.description ?? '')}</div>
                {node.data?.microLabel && (
                  <div className="text-[8px] font-mono text-cyan-400/90 truncate mt-0.5">{String(node.data.microLabel)}</div>
                )}
              </div>
              <span className={`text-[8px] font-mono uppercase shrink-0 ${statusCls}`}>{status}</span>
            </button>
            {i < MOBILE_PIPELINE_ORDER.length - 1 && (
              <div className="flex justify-center py-0.5 text-slate-700">
                <ChevronDown size={14} />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
