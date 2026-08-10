/**
 * ==========================================================
 * Module:
 * SystemBootstrap.ts
 *
 * Purpose:
 * Core implementation and logic for the SystemBootstrap.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for SystemBootstrap
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

import { portfolioReconciliationWorker } from '../services/PortfolioReconciliation';
import { advancedQuantEngines } from '../engines/AdvancedQuantEngines';
import { db } from '../db';
import { marketDataWorker } from '../services/MarketDataWorker';
import { portfolioMonitor } from '../services/PortfolioMonitor';
import { oms } from '../services/OrderManagement'; 
import { riskAgent } from '../services/RiskAgent'; 
import { technicalAgent } from '../services/TechnicalAgent'; 
import { newsEngine } from '../news/NewsEngine';
import { fundamentalAgent } from '../services/FundamentalAgent';
import { macroAgent } from '../services/MacroAgent';
import { chiefTrader } from '../services/ChiefTraderAgent';
import { reflectionEngine } from '../services/ReflectionEngine';
import { predictionOutcomeEvaluator } from '../services/PredictionOutcomeEvaluator';
import { systemMetricsWorker } from '../services/SystemMetricsWorker';
import { marketRegimeAgent } from '../services/MarketRegimeAgent';
import { explainabilityAgent } from '../services/ExplainabilityAgent';
import { kronosEngine } from '../engines/kronos/KronosEngine';

import { kronosForecastAgent } from "../services/KronosForecastAgent";
import { dbBackupService } from '../services/DbBackupService';

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
    newsEngine.start();
    fundamentalAgent.start();
    macroAgent.start();
    reflectionEngine.start();
    predictionOutcomeEvaluator.start();
    systemMetricsWorker.start();
    dbBackupService.start();
    marketRegimeAgent;
    explainabilityAgent;
    kronosForecastAgent;
    kronosEngine.initialize();
    
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
    newsEngine.stop();
    fundamentalAgent.stop();
    macroAgent.stop();
    reflectionEngine.stop();
    predictionOutcomeEvaluator.stop();
    systemMetricsWorker.stop();
    dbBackupService.stop();

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
