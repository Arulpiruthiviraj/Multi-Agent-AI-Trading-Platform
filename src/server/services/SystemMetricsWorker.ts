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
import os from 'os';

export class SystemMetricsWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private processStats: Record<string, any> = {};

  start() {
    if (this.intervalId) return;
    
    // Initialize mock queues for visual purposes
    ['market-data-worker', 'news-agent', 'macro-agent', 'fundamental-agent', 'technical-engine', 'portfolio-monitor', 'risk-engine', 'order-management', 'reflection-engine'].forEach(w => {
       this.processStats[w] = { eventsProcessed: 0, status: 'Sleeping', cpu: 0, memory: 0, latency: 0 };
    });
    
    // Wire into event bus to update stats
    eventBus.on('MARKET_DATA', () => this.recordEvent('market-data-worker'));
    eventBus.on('TRADE_IDEA_GENERATED', (data) => this.recordEvent(data.agent === 'NewsAgent' ? 'news-agent' : data.agent === 'MacroAgent' ? 'macro-agent' : data.agent === 'FundamentalAgent' ? 'fundamental-agent' : 'technical-engine'));
    eventBus.on('CALCULATION_COMPLETED', () => this.recordEvent('technical-engine'));
    eventBus.on('RISK_ASSESSMENT_COMPLETED', () => this.recordEvent('risk-engine'));
    eventBus.on('ORDER_EXECUTED', () => this.recordEvent('order-management'));
    eventBus.on('NEW_RULE_LEARNED', () => this.recordEvent('reflection-engine'));

    this.intervalId = setInterval(() => this.broadcastMetrics(), 2000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  recordEvent(worker: string) {
      if (!this.processStats[worker]) this.processStats[worker] = { eventsProcessed: 0, status: 'Executing' };
      
      this.processStats[worker].eventsProcessed += 1;
      this.processStats[worker].status = 'Executing';
      this.processStats[worker].latency = 0; // Removed Math.random() mock
      
      // Revert to sleeping after a bit
      setTimeout(() => {
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
     
     eventBus.publish('SYSTEM_METRICS', {
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
