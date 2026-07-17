import { useState, useEffect } from 'react';

export interface TraceEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: any;
}

export function useEventBusTrace(targetTraceId: string | null) {
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);

  useEffect(() => {
    if (!targetTraceId) {
      setTraceEvents([]);
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Only collect events for our targeted traceId
        if (msg.data && msg.data.traceId === targetTraceId) {
          const newEvent = {
            id: Math.random().toString(36).substring(7),
            type: msg.type,
            timestamp: msg.data.timestamp || new Date().toISOString(),
            payload: msg.data
          };
          setTraceEvents(prev => [...prev, newEvent]);
        }
      } catch (e) {
        // ignore
      }
    };

    return () => {
      ws.close();
    };
  }, [targetTraceId]);

  return traceEvents;
}
