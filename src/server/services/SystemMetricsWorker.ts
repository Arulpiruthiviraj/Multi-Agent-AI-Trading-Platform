/**
 * ==========================================================
 * Module:
 * SystemMetricsWorker.ts
 *
 * Purpose:
 * Core implementation and logic for the SystemMetricsWorker.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for SystemMetricsWorker
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

import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { runtimeIntervals } from '../config/runtimeIntervals';
import os from 'os';

export class SystemMetricsWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private processStats: Record<string, any> = {};
  /** One shared debounce timer per worker for the Executing->Waiting decay. The old code
   *  allocated a fresh 500ms setTimeout on EVERY event (hundreds/sec at tick rates) - but only
   *  the last timer to fire ever had a visible effect, so a single re-armed timer per worker
   *  produces byte-identical status transitions with at most 9 live timers. */
  private decayTimers: Record<string, NodeJS.Timeout> = {};

  // 2026-10-09 defect hunt: start() registers six EventBus listeners. stop() must unsubscribe
  // exactly what start() subscribed, or every Autobot toggle leaks six listeners (each
  // re-running recordEvent per event and retaining its closure). Stored as fields so off()
  // removes the identical function references on() added.
  private boundListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  start() {
    if (this.intervalId) return;
    
    // Initialize mock queues for visual purposes
    ['market-data-worker', 'news-agent', 'macro-agent', 'fundamental-agent', 'technical-engine', 'portfolio-monitor', 'risk-engine', 'order-management', 'reflection-engine'].forEach(w => {
       this.processStats[w] = { eventsProcessed: 0, status: 'Sleeping', cpu: 0, memory: 0, latency: 0 };
    });
    
    // Wire into event bus to update stats - every listener is tracked so stop() can
    // unsubscribe the identical references (anonymous inline functions could never be removed).
    this.boundListeners = [
      { event: 'MARKET_DATA', fn: () => this.recordEvent('market-data-worker') },
      { event: 'TRADE_IDEA_GENERATED', fn: (data) => this.recordEvent(data.agent === 'NewsAgent' ? 'news-agent' : data.agent === 'MacroAgent' ? 'macro-agent' : data.agent === 'FundamentalAgent' ? 'fundamental-agent' : 'technical-engine') },
      { event: 'CALCULATION_COMPLETED', fn: () => this.recordEvent('technical-engine') },
      { event: 'RISK_ASSESSMENT_COMPLETED', fn: () => this.recordEvent('risk-engine') },
      { event: 'ORDER_EXECUTED', fn: () => this.recordEvent('order-management') },
      { event: 'LEARNED_NEW_RULE', fn: () => this.recordEvent('reflection-engine') },
    ];
    for (const { event, fn } of this.boundListeners) eventBus.on(event, fn);

    this.intervalId = setInterval(() => this.broadcastMetrics(), runtimeIntervals.systemMetricsMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Unsubscribe every listener start() registered - without this, each start->stop->start
    // cycle leaked six duplicate listeners (proven by SystemMetricsWorker.lifecycle.test.ts).
    for (const { event, fn } of this.boundListeners) eventBus.off(event, fn);
    this.boundListeners = [];
    for (const w of Object.keys(this.decayTimers)) clearTimeout(this.decayTimers[w]);
    this.decayTimers = {};
  }

  recordEvent(worker: string) {
      if (!this.processStats[worker]) this.processStats[worker] = { eventsProcessed: 0, status: 'Executing' };
      
      this.processStats[worker].eventsProcessed += 1;
      this.processStats[worker].status = 'Executing';
      this.processStats[worker].latency = 0; // Removed Math.random() mock
      
      // Revert to Waiting 500ms after the LAST event (debounced, not one timer per event).
      const prev = this.decayTimers[worker];
      if (prev) clearTimeout(prev);
      this.decayTimers[worker] = setTimeout(() => {
          delete this.decayTimers[worker];
          if (this.processStats[worker]) {
             this.processStats[worker].status = 'Waiting';
          }
      }, 500);
  }

  broadcastMetrics() {
     for (const w of Object.keys(this.processStats)) {
         // MOCKS REMOVED: Do not fabricate per-worker CPU/Mem if it's not actually measured
         this.processStats[w].cpu = "0.0"; 
         this.processStats[w].memory = "0";
     }
     
     const systemMemory = process.memoryUsage();
     
     eventBus.publish(EVENTS.SYSTEM_METRICS, {
        processes: this.processStats,
        system: {
            heapUsed: Math.floor(systemMemory.heapUsed / 1024 / 1024),
            heapTotal: Math.floor(systemMemory.heapTotal / 1024 / 1024),
            cpuUsage: process.cpuUsage(),
            uptime: process.uptime()
        },
        timestamp: new Date().toISOString()
     });
  }
}

export const systemMetricsWorker = new SystemMetricsWorker();
