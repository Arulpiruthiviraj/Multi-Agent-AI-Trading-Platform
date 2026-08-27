/**
 * Frontend WebSocket transport health - distinct from ConnectionStatusDashboard, which reports
 * BACKEND service health (broker/market data/DB/Ollama/Chronos/OpenAlice/news via
 * GET /api/v2/diagnostics). This component reports only whether THIS browser tab's live event
 * stream is up - a disconnected badge here does not mean Argus itself is unhealthy (Phase 3B,
 * CLAUDE.md section 5: "Do not let a disconnected UI imply that Argus itself is unhealthy").
 */
import React from 'react';
import { Wifi, WifiOff, RotateCw, AlertTriangle } from 'lucide-react';
import { useWebSocket } from '../context/WebSocketContext';

const STATUS_META: Record<string, { label: string; icon: typeof Wifi; color: string; bg: string }> = {
  connected: { label: 'Live', icon: Wifi, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30' },
  stale: { label: 'Degraded', icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' },
  reconnecting: { label: 'Reconnecting', icon: RotateCw, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' },
  connecting: { label: 'Connecting', icon: RotateCw, color: 'text-sky-400', bg: 'bg-sky-500/10 border-sky-500/30' },
  disconnected: { label: 'Disconnected', icon: WifiOff, color: 'text-rose-400', bg: 'bg-rose-500/10 border-rose-500/30' },
};

export default function ConnectionHealthBadge() {
  const { status, latencyMs, reconnectAttempt } = useWebSocket();
  const meta = STATUS_META[status] ?? STATUS_META.disconnected;
  const Icon = meta.icon;

  let detail: string;
  if (status === 'connected') {
    detail = latencyMs != null ? `${latencyMs}ms round-trip` : 'awaiting first heartbeat';
  } else if (status === 'stale') {
    detail = 'no heartbeat reply — connection open, may drop soon';
  } else if (status === 'reconnecting') {
    detail = `attempt ${reconnectAttempt}`;
  } else if (status === 'connecting') {
    detail = 'establishing connection';
  } else {
    detail = 'not connected';
  }

  return (
    <div className={`flex items-center gap-3 border rounded-lg px-4 py-2.5 font-mono ${meta.bg}`}>
      <Icon size={14} className={`${meta.color} ${status === 'reconnecting' || status === 'connecting' ? 'animate-spin' : ''}`} />
      <div>
        <div className={`text-xs font-bold uppercase tracking-widest ${meta.color}`}>
          Live feed &middot; {meta.label}
        </div>
        <div className="text-[10px] text-slate-500 uppercase tracking-widest mt-0.5">{detail}</div>
      </div>
    </div>
  );
}
