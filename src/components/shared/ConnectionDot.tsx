import React from 'react';
import { useWebSocket } from '../../context/WebSocketContext';
import { LiveDot } from './LiveDot';

/**
 * ConnectionDot — compact always-visible WebSocket health indicator for the
 * persistent nav chrome.
 *
 * Why this exists: the full ConnectionHealthBadge lives inside the Settings
 * tab, so a dropped socket on any other tab silently froze the live feed
 * with no visible signal. This pill sits in the sticky tab strip (visible on
 * every tab) and mirrors the same status source.
 */
const LABEL: Record<string, string> = {
  connected: 'Live',
  stale: 'Degraded',
  reconnecting: 'Reconnecting',
  connecting: 'Connecting',
  disconnected: 'Offline',
};

export function ConnectionDot() {
  const { status, reconnectAttempt } = useWebSocket();
  const dotStatus =
    status === 'connected'
      ? 'live'
      : status === 'stale' || status === 'reconnecting' || status === 'connecting'
        ? 'degraded'
        : status === 'disconnected'
          ? 'down'
          : 'idle';
  const label = LABEL[status] ?? 'Offline';
  const detail =
    status === 'reconnecting' ? `Live · ${label} (try ${reconnectAttempt})` : `Live feed · ${label}`;
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[10px] text-slate-500"
      title={detail}
      role="status"
      aria-label={detail}
    >
      <LiveDot status={dotStatus} size={7} />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}
