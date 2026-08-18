/**
 * Stable React Flow node/edge type registry for DigitalTwinVisualizer.
 * Kept in a separate module so Vite HMR on the visualizer does not recreate type maps (reactflow #002).
 */
import React from 'react';
import { motion } from 'motion/react';
import {
  BaseEdge,
  EdgeProps,
  Handle,
  Position,
  getBezierPath,
} from 'reactflow';

export type NodeCategory = 'source' | 'agent' | 'local-model' | 'paid-model' | 'decision' | 'risk' | 'execution';
export type VisualStatus = 'IDLE' | 'PULSE' | 'PROCESSING' | 'SUCCESS' | 'FAIL';

export interface Packet {
  id: string;
  color: string;
  kind?: 'flow' | 'reject';
}

const CATEGORY_STYLE: Record<NodeCategory, { border: string; glow: string; iconBg: string; iconText: string; accent: string }> = {
  source: { border: 'border-cyan-500', glow: 'rgba(34,211,238,0.55)', iconBg: 'bg-cyan-500/20', iconText: 'text-cyan-300', accent: '#22d3ee' },
  agent: { border: 'border-violet-500', glow: 'rgba(167,139,250,0.5)', iconBg: 'bg-violet-500/20', iconText: 'text-violet-300', accent: '#a78bfa' },
  'local-model': { border: 'border-emerald-500', glow: 'rgba(16,185,129,0.5)', iconBg: 'bg-emerald-500/20', iconText: 'text-emerald-300', accent: '#34d399' },
  'paid-model': { border: 'border-amber-500', glow: 'rgba(245,158,11,0.5)', iconBg: 'bg-amber-500/20', iconText: 'text-amber-300', accent: '#fbbf24' },
  decision: { border: 'border-fuchsia-500', glow: 'rgba(232,121,249,0.5)', iconBg: 'bg-fuchsia-500/20', iconText: 'text-fuchsia-300', accent: '#e879f9' },
  risk: { border: 'border-rose-500', glow: 'rgba(244,63,94,0.5)', iconBg: 'bg-rose-500/20', iconText: 'text-rose-300', accent: '#fb7185' },
  execution: { border: 'border-teal-500', glow: 'rgba(45,212,191,0.5)', iconBg: 'bg-teal-500/20', iconText: 'text-teal-300', accent: '#2dd4bf' },
};

function TelemetryNode({ id, data }: { id: string; data: any }) {
  const style = CATEGORY_STYLE[data.category as NodeCategory] || CATEGORY_STYLE.agent;
  const status: VisualStatus = data.status || 'IDLE';
  const active = status !== 'IDLE';
  const border =
    status === 'FAIL' ? 'border-rose-400' :
    status === 'SUCCESS' ? 'border-emerald-400' :
    status === 'PROCESSING' ? style.border :
    status === 'PULSE' ? style.border : 'border-slate-800';
  const glow =
    status === 'FAIL' ? 'rgba(244,63,94,0.7)' :
    status === 'SUCCESS' ? 'rgba(16,185,129,0.7)' :
    active ? style.glow : undefined;

  return (
    <div className="group relative">
      {status === 'IDLE' && (
        <motion.div
          className="absolute inset-0 rounded-xl pointer-events-none border border-slate-800/80"
          animate={{ opacity: [0.35, 0.65, 0.35] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      {status === 'PULSE' && (
        <motion.div
          key={data.pulseKey}
          className="absolute inset-0 rounded-xl pointer-events-none"
          initial={{ opacity: 0.7, scale: 1 }}
          animate={{ opacity: 0, scale: 1.28 }}
          transition={{ duration: 0.55, ease: 'easeOut' }}
          style={{ boxShadow: `0 0 0 2px ${style.glow}`, background: style.glow }}
        />
      )}
      {status === 'FAIL' && (
        <motion.div
          key={`fail-${data.pulseKey ?? id}`}
          className="absolute inset-0 rounded-xl pointer-events-none"
          initial={{ opacity: 0.9, scale: 1 }}
          animate={{ opacity: 0, scale: 1.6 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          style={{ boxShadow: '0 0 0 2px rgba(251,113,133,0.95)', background: 'rgba(244,63,94,0.28)' }}
        />
      )}
      {status === 'PROCESSING' && (
        <motion.div
          className="absolute -inset-1 rounded-xl pointer-events-none border border-cyan-400/40"
          animate={{ opacity: [0.35, 0.85, 0.35], scale: [1, 1.04, 1] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <motion.div
        layoutId={data.focused ? undefined : `agent-node-${id}`}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className={`relative cursor-pointer px-4 py-3 w-52 shadow-lg rounded-xl bg-[#0A0F16] border-2 ${border} font-mono`}
        style={active && glow ? { boxShadow: `0 0 18px ${glow}` } : undefined}
      >
        <Handle type="target" position={Position.Top} className="w-2 h-2 bg-slate-500 border-none" />
        <div className="flex items-center gap-3">
          <div className={`rounded-lg p-2.5 ${active ? `${style.iconBg} ${style.iconText}` : 'bg-slate-800 text-slate-500'}`}>
            {data.icon}
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-bold text-white uppercase tracking-widest leading-tight truncate">{data.label}</div>
            <div className="text-[8px] text-slate-400 mt-0.5">{data.description}</div>
            <div className={`text-[8px] mt-1 font-mono ${status === 'FAIL' ? 'text-rose-400' : status === 'SUCCESS' ? 'text-emerald-400' : status === 'PROCESSING' ? 'text-amber-300' : active ? style.iconText : 'text-slate-600'}`}>
              {status === 'IDLE' ? 'IDLE' : status}
              {typeof data.throughput === 'number' && data.throughput > 0 && (
                <span className="ml-1 text-cyan-500/80">×{data.throughput}</span>
              )}
            </div>
            {data.microLabel && (
              <div className="text-[8px] mt-0.5 font-mono text-cyan-300/90 truncate" title={String(data.microLabel)}>
                {data.microLabel}
              </div>
            )}
          </div>
        </div>
        <Handle type="source" position={Position.Bottom} className="w-2 h-2 bg-slate-500 border-none" />
      </motion.div>
      <div className="pointer-events-none absolute left-full top-0 z-50 ml-2 hidden w-64 group-hover:block">
        <div className="rounded-lg border border-cyan-500/30 bg-[#0A0F16]/95 p-3 shadow-[0_0_24px_rgba(34,211,238,0.15)] backdrop-blur-sm">
          <div className="mb-2 text-[9px] font-bold uppercase tracking-widest text-cyan-300">{data.label}</div>
          {(data.hoverRows as { label: string; value: string }[] || []).map((row) => (
            <div key={row.label} className="mb-1 flex justify-between gap-2 font-mono text-[9px]">
              <span className="text-slate-500">{row.label}</span>
              <span className="max-w-[9rem] truncate text-right text-slate-200" title={row.value}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PacketEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data }: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const packets: Packet[] = data?.packets || [];
  const lit = packets.length > 0;
  const lastKind = packets[packets.length - 1]?.kind;
  const strokeColor = lit
    ? (packets[packets.length - 1]?.color || '#22d3ee')
    : (style?.stroke || '#334155');
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: strokeColor,
          strokeWidth: lit ? 2.5 : 1.5,
          opacity: lit ? 1 : 0.45,
          strokeDasharray: lastKind === 'reject' ? '4 3' : undefined,
        }}
      />
      {packets.map((p) => {
        const reject = p.kind === 'reject';
        const dur = reject ? 550 + 180 : 550;
        return (
          <circle key={p.id} r={reject ? 4.5 : 3.5} fill={p.color} opacity={0.95}>
            <animateMotion
              dur={`${dur}ms`}
              fill="remove"
              path={edgePath}
              keyPoints={reject ? '0;0.48;0.48' : '0;1'}
              keyTimes={reject ? '0;0.55;1' : '0;1'}
              calcMode="linear"
            />
            {reject && (
              <animate
                attributeName="opacity"
                values="1;1;0"
                keyTimes="0;0.55;1"
                dur={`${dur}ms`}
                fill="remove"
              />
            )}
          </circle>
        );
      })}
    </>
  );
}

export { TelemetryNode, PacketEdge };
