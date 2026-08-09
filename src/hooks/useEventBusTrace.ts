/**
 * ==========================================================
 * Module:
 * useEventBusTrace.ts
 *
 * Purpose:
 * Core implementation and logic for the useEventBusTrace.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for useEventBusTrace
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

import { useState, useEffect } from 'react';
import { useWebSocket } from '../context/WebSocketContext';

export interface TraceEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: any;
}

export function useEventBusTrace(targetTraceId: string | null) {
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const { subscribe } = useWebSocket();

  useEffect(() => {
    if (!targetTraceId) {
      setTraceEvents([]);
      return;
    }

    const handlers = [
      'TRADE_IDEA_GENERATED',
      'CHIEF_APPROVED_IDEA',
      'RISK_ASSESSMENT_COMPLETED',
      'ORDER_EXECUTED',
      'LEARNED_NEW_RULE',
      'MARKET_DATA',
      'SYSTEM_METRICS',
      'CALCULATION_COMPLETED'
    ];

    const unsubscribes = handlers.map(eventType => {
      return subscribe(eventType, (data) => {
        if (data && (data.traceId === targetTraceId || data.trace_id === targetTraceId)) {
          const newEvent = {
            id: Math.random().toString(36).substring(7),
            type: eventType,
            timestamp: data.timestamp || new Date().toISOString(),
            payload: data
          };
          setTraceEvents(prev => [...prev, newEvent]);
        }
      });
    });

    return () => {
      unsubscribes.forEach(unsub => unsub());
    };
  }, [targetTraceId, subscribe]);

  return traceEvents;
}
