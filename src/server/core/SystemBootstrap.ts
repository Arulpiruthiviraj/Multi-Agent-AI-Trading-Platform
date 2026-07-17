import { portfolioReconciliationWorker } from '../services/PortfolioReconciliation';
import { advancedQuantEngines } from '../engines/AdvancedQuantEngines';
import { db } from '../db';
import { marketDataWorker } from '../services/MarketDataWorker';
import { portfolioMonitor } from '../services/PortfolioMonitor';
import { oms } from '../services/OrderManagement'; 
import { riskAgent } from '../services/RiskAgent'; 
import { technicalAgent } from '../services/TechnicalAgent'; 
import { newsAgent } from '../services/NewsAgent';
import { fundamentalAgent } from '../services/FundamentalAgent';
import { macroAgent } from '../services/MacroAgent';
import { chiefTrader } from '../services/ChiefTraderAgent';
import { reflectionEngine } from '../services/ReflectionEngine';
import { systemMetricsWorker } from '../services/SystemMetricsWorker';

export class SystemBootstrap {
  private isRunning = false;
  private mode: 'SIMULATION' | 'PAPER' | 'LIVE' = 'SIMULATION';

  start(mode: 'SIMULATION' | 'PAPER' | 'LIVE' = 'SIMULATION') {
    if (this.isRunning) return;
    this.mode = mode;
    console.log("===================================");
    console.log(`[Argus System] Bootstrapping real workers in ${mode} mode...`);
    
    oms;
    riskAgent;
    technicalAgent;
    chiefTrader;
    advancedQuantEngines.start();
    
    marketDataWorker.start();
    portfolioMonitor.start();
    portfolioReconciliationWorker.start();
    newsAgent.start();
    fundamentalAgent.start();
    macroAgent.start();
    reflectionEngine.start();
    systemMetricsWorker.start();
    
    this.isRunning = true;
    console.log("[Argus System] All workers online.");
    console.log("===================================");
  }

  stop() {
    if (!this.isRunning) return;
    console.log("[Argus System] Shutting down workers...");
    
    marketDataWorker.stop();
    portfolioMonitor.stop();
    portfolioReconciliationWorker.stop();
    newsAgent.stop();
    fundamentalAgent.stop();
    macroAgent.stop();
    reflectionEngine.stop();
    systemMetricsWorker.stop();
    
    this.isRunning = false;
    console.log("[Argus System] Shutdown complete.");
  }

  getStatus() {
    return {
      running: this.isRunning,
      mode: this.mode,
      dbConnected: !!db
    };
  }
}

export const system = new SystemBootstrap();
