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
      this.processStats[worker].latency = Math.floor(Math.random() * 50) + 10;
      
      // Revert to sleeping after a bit
      setTimeout(() => {
          if (this.processStats[worker]) {
             this.processStats[worker].status = 'Waiting';
          }
      }, 500);
  }

  broadcastMetrics() {
     for (const w of Object.keys(this.processStats)) {
         this.processStats[w].cpu = (Math.random() * (this.processStats[w].status === 'Executing' ? 15 : 2)).toFixed(1);
         this.processStats[w].memory = (Math.random() * 50 + 20).toFixed(0);
     }
     
     const systemMemory = process.memoryUsage();
     
     eventBus.emit('SYSTEM_METRICS', {
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
