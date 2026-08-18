/**
 * ==========================================================
 * Module:
 * WebSocketContext.tsx
 *
 * Purpose:
 * Core implementation and logic for the WebSocketContext.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for WebSocketContextx
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

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { resolveWebSocketUrl } from '../lib/clientFetch';

type WebSocketStatus = 'connecting' | 'connected' | 'disconnected';

interface WebSocketContextType {
  status: WebSocketStatus;
  lastMessage: any | null;
  /** Round-trip ping→pong latency in ms; null until first pong. */
  latencyMs: number | null;
  sendMessage: (msg: any) => void;
  subscribe: (eventType: string, callback: (data: any) => void) => () => void;
  /** Close and reconnect (respects exponential backoff in onclose). */
  forceReconnect: () => void;
  /** DEF-22: connect only after the SPA has a confirmed session. */
  setEnabled: (enabled: boolean) => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const WebSocketProvider = ({ children }: { children: ReactNode }) => {
  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const [lastMessage, setLastMessage] = useState<any | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const pingSentAt = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
  const subscribers = useRef<Map<string, Set<(data: any) => void>>>(new Map());
  const reconnectAttempts = useRef(0);
  const heartbeatInterval = useRef<NodeJS.Timeout | null>(null);
  const lastPong = useRef<number>(Date.now());
  // Hardening pass, Phase 9 (WebSocket reconnect backfill): captured at the moment the socket
  // actually drops (before the reconnect delay begins), so a subsequent successful reconnect
  // knows exactly which real events - MARKET_DATA/CALCULATION_COMPLETED excluded, matching
  // EventStore.ts's own persistence scope - to backfill from GET /api/v2/system/events?since=.
  // null until the first disconnect, so the very first page load never triggers a backfill fetch.
  const lastDisconnectedAt = useRef<number | null>(null);
  const appliedBackfillEventIds = useRef<Set<string>>(new Set());
  const disposedRef = useRef(false);
  const enabledRef = useRef(false);
  // Real perf fix (2026-08-18): `lastMessage` has no consumers anywhere in src/ (every real
  // subscriber uses subscribe() below, which calls back directly - not through React state), but
  // setLastMessage() fired on every single message including high-frequency MARKET_DATA/
  // MODEL_HEALTH ticks. Each call gave the memoized context `value` a new identity (lastMessage is
  // in its deps), re-rendering every component that merely calls useWebSocket() for
  // sendMessage/subscribe, even though none of them read lastMessage. Throttled to 250ms here -
  // only the exposed `lastMessage` state is delayed; subscriber callbacks below still fire
  // synchronously on every message, so real-time correctness (fills, resumes, risk events) is
  // unaffected.
  const lastMessageThrottle = useRef<{ pending: any; timer: ReturnType<typeof setTimeout> | null }>({ pending: null, timer: null });

  // Shared by both a live WS message and a backfilled event, so a replayed event reaches
  // subscribers identically to how it would have if the client had never disconnected.
  const dispatchPayload = (payload: { type: string; data: any }) => {
    lastMessageThrottle.current.pending = payload;
    if (!lastMessageThrottle.current.timer) {
      lastMessageThrottle.current.timer = setTimeout(() => {
        setLastMessage(lastMessageThrottle.current.pending);
        lastMessageThrottle.current.timer = null;
      }, 250);
    }
    if (payload.type && subscribers.current.has(payload.type)) {
      subscribers.current.get(payload.type)!.forEach(cb => cb(payload.data));
    }
  };

  // Fetches everything the durable event_traces table recorded after `sinceMs` and replays it
  // through the same dispatch path a live message uses. Best-effort by design: a fetch failure
  // just means the client stays caught-up only from this point forward (the same behavior as
  // before this phase), never a hard error surfaced to the user - a missed-event backfill is a
  // nice-to-have, not a safety-critical path.
  const backfillMissedEvents = async (sinceMs: number) => {
    try {
      const res = await fetch(`/api/v2/system/events?since=${sinceMs}`, { credentials: 'include' });
      if (res.status === 401) return;
      if (!res.ok) return;
      const body = await res.json();
      if (!body.ok || !Array.isArray(body.events)) return;
      for (const evt of body.events) {
        if (evt.eventId) {
          if (appliedBackfillEventIds.current.has(evt.eventId)) continue;
          appliedBackfillEventIds.current.add(evt.eventId);
          if (appliedBackfillEventIds.current.size > 500) {
            const oldest = appliedBackfillEventIds.current.values().next().value;
            if (oldest) appliedBackfillEventIds.current.delete(oldest);
          }
        }
        dispatchPayload({ type: evt.type, data: evt.payload });
      }
      if (body.events.length > 0) {
        console.log(`[WebSocketContext] Backfilled ${body.events.length} event(s) missed while disconnected.`);
      }
    } catch (e) {
      console.warn('[WebSocketContext] Reconnect backfill fetch failed - continuing with live events only.', e);
    }
  };

  const connect = () => {
    if (!enabledRef.current) return;
    if (disposedRef.current) return;
    if (ws.current?.readyState === WebSocket.OPEN || ws.current?.readyState === WebSocket.CONNECTING) return;

    setStatus('connecting');
    setLatencyMs(null);
    const newWs = new WebSocket(resolveWebSocketUrl());

    newWs.onopen = () => {
      if (disposedRef.current) {
        newWs.close();
        return;
      }
      setStatus('connected');
      reconnectAttempts.current = 0;
      console.log('[WebSocketContext] Connected to server.');

      // Only a reconnect (not the initial page load) has a real gap to backfill.
      if (lastDisconnectedAt.current !== null) {
        backfillMissedEvents(lastDisconnectedAt.current);
        lastDisconnectedAt.current = null;
      }

      // Start heartbeat — 3s PING/PONG for live latency on mobile Mission Control.
      lastPong.current = Date.now();
      const sendPing = () => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          const ts = Date.now();
          pingSentAt.current = ts;
          ws.current.send(JSON.stringify({ type: 'PING', timestamp: ts }));
        }
      };
      sendPing();
      heartbeatInterval.current = setInterval(() => {
        sendPing();
        if (Date.now() - lastPong.current > 12000) {
          console.warn('[WebSocketContext] Heartbeat timeout. Reconnecting...');
          ws.current?.close();
        }
      }, 3000);
    };

    newWs.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const kind = String(payload.type || '').toLowerCase();
        if (kind === 'pong') {
          lastPong.current = Date.now();
          if (typeof payload.timestamp === 'number') {
            setLatencyMs(Math.max(0, Date.now() - payload.timestamp));
          } else if (pingSentAt.current != null) {
            setLatencyMs(Math.max(0, Date.now() - pingSentAt.current));
          }
          pingSentAt.current = null;
          return;
        }

        dispatchPayload(payload);
      } catch (e) {
        console.error('[WebSocketContext] Error parsing message', e);
      }
    };

    newWs.onclose = () => {
      if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
      if (ws.current === newWs) ws.current = null;
      if (disposedRef.current || !enabledRef.current) {
        setStatus('disconnected');
        return;
      }
      setStatus('disconnected');
      // Captured at the moment of disconnect (not when the reconnect attempt later succeeds) -
      // this is the real start of the gap a backfill needs to cover.
      lastDisconnectedAt.current = Date.now();

      const timeout = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
      reconnectAttempts.current++;

      console.log(`[WebSocketContext] Disconnected. Reconnecting in ${timeout}ms...`);
      reconnectTimeout.current = setTimeout(connect, timeout);
    };

    newWs.onerror = () => {
      // Silently handle transient connection errors during retry cycles
      if (ws.current === newWs) {
        ws.current = null;
      }
    };

    ws.current = newWs;
  };

  connectRef.current = connect;

  const forceReconnect = useCallback(() => {
    if (disposedRef.current || !enabledRef.current) return;
    if (heartbeatInterval.current) {
      clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = null;
    }
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    const socket = ws.current;
    ws.current = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    lastDisconnectedAt.current = Date.now();
    setStatus('disconnected');
    setLatencyMs(null);
    reconnectAttempts.current = Math.min(reconnectAttempts.current, 8);
    connectRef.current();
  }, []);

  const disconnectQuietly = () => {
    if (heartbeatInterval.current) {
      clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = null;
    }
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    const socket = ws.current;
    ws.current = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
    setStatus('disconnected');
    setLatencyMs(null);
  };

  const setEnabled = useCallback((enabled: boolean) => {
    enabledRef.current = enabled;
    if (!enabled) {
      disconnectQuietly();
      return;
    }
    disposedRef.current = false;
    connectRef.current();
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    // DEF-22: do not connect until App reports isAuthenticated via setEnabled.
    return () => {
      disposedRef.current = true;
      disconnectQuietly();
      if (lastMessageThrottle.current.timer) {
        clearTimeout(lastMessageThrottle.current.timer);
        lastMessageThrottle.current.timer = null;
      }
    };
  }, []);

  // Stable identities: App.tsx (and others) put `subscribe` in useEffect deps. Recreating
  // subscribe on every lastMessage/status update re-ran those effects → fetch → setState →
  // Maximum update depth exceeded (see App.tsx ~1071 AUTOBOT_STATE_UPDATED effect).
  const sendMessage = useCallback((msg: any) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    } else {
      console.warn('[WebSocketContext] Cannot send message, WebSocket not open.');
    }
  }, []);

  const subscribe = useCallback((eventType: string, callback: (data: any) => void) => {
    if (!subscribers.current.has(eventType)) {
      subscribers.current.set(eventType, new Set());
    }
    subscribers.current.get(eventType)!.add(callback);

    return () => {
      if (subscribers.current.has(eventType)) {
        subscribers.current.get(eventType)!.delete(callback);
      }
    };
  }, []);

  const value = useMemo(
    () => ({ status, lastMessage, latencyMs, sendMessage, subscribe, forceReconnect, setEnabled }),
    [status, lastMessage, latencyMs, sendMessage, subscribe, forceReconnect, setEnabled],
  );

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocket = () => {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within a WebSocketProvider');
  return ctx;
};
