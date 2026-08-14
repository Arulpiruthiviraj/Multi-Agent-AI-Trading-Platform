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

import React, { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';

type WebSocketStatus = 'connecting' | 'connected' | 'disconnected';

interface WebSocketContextType {
  status: WebSocketStatus;
  lastMessage: any | null;
  sendMessage: (msg: any) => void;
  subscribe: (eventType: string, callback: (data: any) => void) => () => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const WebSocketProvider = ({ children }: { children: ReactNode }) => {
  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const [lastMessage, setLastMessage] = useState<any | null>(null);
  const ws = useRef<WebSocket | null>(null);
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
  // Best-effort de-dup for the short overlap window between a backfill response landing and a
  // live event for the same occurrence arriving over the newly-reopened socket - bounded so it
  // can't grow unbounded over a long session.
  const appliedBackfillEventIds = useRef<Set<string>>(new Set());

  // Shared by both a live WS message and a backfilled event, so a replayed event reaches
  // subscribers identically to how it would have if the client had never disconnected.
  const dispatchPayload = (payload: { type: string; data: any }) => {
    setLastMessage(payload);
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
      const res = await fetch(`/api/v2/system/events?since=${sinceMs}`);
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
    if (ws.current?.readyState === WebSocket.OPEN) return;

    setStatus('connecting');
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const newWs = new WebSocket(`${protocol}//${window.location.host}/ws`);

    newWs.onopen = () => {
      setStatus('connected');
      reconnectAttempts.current = 0;
      console.log('[WebSocketContext] Connected to server.');

      // Only a reconnect (not the initial page load) has a real gap to backfill.
      if (lastDisconnectedAt.current !== null) {
        backfillMissedEvents(lastDisconnectedAt.current);
        lastDisconnectedAt.current = null;
      }

      // Start heartbeat
      lastPong.current = Date.now();
      heartbeatInterval.current = setInterval(() => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ type: 'ping' }));

          if (Date.now() - lastPong.current > 15000) {
            console.warn('[WebSocketContext] Heartbeat timeout. Reconnecting...');
            ws.current.close();
          }
        }
      }, 5000);
    };

    newWs.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'pong') {
          lastPong.current = Date.now();
          return;
        }

        dispatchPayload(payload);
      } catch (e) {
        console.error('[WebSocketContext] Error parsing message', e);
      }
    };

    newWs.onclose = () => {
      if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
      setStatus('disconnected');
      ws.current = null;
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

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      if (ws.current) {
        ws.current.close();
      }
    };
  }, []);

  const sendMessage = (msg: any) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    } else {
      console.warn('[WebSocketContext] Cannot send message, WebSocket not open.');
    }
  };

  const subscribe = (eventType: string, callback: (data: any) => void) => {
    if (!subscribers.current.has(eventType)) {
      subscribers.current.set(eventType, new Set());
    }
    subscribers.current.get(eventType)!.add(callback);
    
    return () => {
      if (subscribers.current.has(eventType)) {
        subscribers.current.get(eventType)!.delete(callback);
      }
    };
  };

  return (
    <WebSocketContext.Provider value={{ status, lastMessage, sendMessage, subscribe }}>
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocket = () => {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within a WebSocketProvider');
  return ctx;
};
