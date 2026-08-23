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
import { opportunityDiscoveryWorker } from '../continuous/OpportunityDiscovery';
import { advancedQuantEngines } from '../engines/AdvancedQuantEngines';
import { db } from '../db';
import { marketDataWorker } from '../services/MarketDataWorker';
import { authorizeMarketDataWebSocket } from './marketDataWsOwnership';
import { portfolioMonitor } from '../services/PortfolioMonitor';
import { oms } from '../services/OrderManagement'; 
import { riskAgent } from '../services/RiskAgent'; 
import { newsEngine } from '../news/NewsEngine';
import { chiefTrader } from '../services/ChiefTraderAgent';
import { reflectionEngine } from '../services/ReflectionEngine';
import { predictionOutcomeEvaluator } from '../services/PredictionOutcomeEvaluator';
import { trainingExampleBuilder } from '../services/TrainingExampleBuilder';
import { systemMetricsWorker } from '../services/SystemMetricsWorker';
import { marketRegimeAgent } from '../services/MarketRegimeAgent';
import { explainabilityAgent } from '../services/ExplainabilityAgent';
import { kronosEngine } from '../engines/kronos/KronosEngine';

import { dbBackupService } from '../services/DbBackupService';
import { tracingService } from '../services/TracingService';
import { installObservabilityEventBridge } from '../observability/instrumentEventBus';
import { startObservabilityRetentionSweep, stopObservabilityRetentionSweep } from '../observability/ObservabilityStore';
import { startProcessTelemetry, stopProcessTelemetry } from '../observability/processTelemetry';
import { transactionLifecycleTracker } from '../services/TransactionLifecycleTracker';
import { marketDataCrossChecker } from '../services/MarketDataCrossChecker';
import { alertingService } from '../services/AlertingService';
import { aiFailureCircuitBreaker } from '../services/AIFailureCircuitBreaker';
import { startEnabledIdeaAgents, stopAllIdeaAgents } from './pipelineAgentRuntime';

export class SystemBootstrap {
  private isRunning = false;
  private mode: 'SIMULATION' | 'PAPER' | 'LIVE' = 'SIMULATION';

  start(mode: 'SIMULATION' | 'PAPER' | 'LIVE' = 'SIMULATION') {
    if (this.isRunning) return;
    this.mode = mode;
    console.log("===================================");
    console.log(`[Argus System] Bootstrapping real workers in ${mode} mode...`);
    
    oms.start();
    alertingService.start();
    aiFailureCircuitBreaker.start();
    riskAgent;
    chiefTrader;
    transactionLifecycleTracker;
    tracingService;
    installObservabilityEventBridge();
    startObservabilityRetentionSweep();
    startProcessTelemetry();
    advancedQuantEngines.start();
    
    authorizeMarketDataWebSocket('SystemBootstrap');
    marketDataWorker.start();
    portfolioMonitor.start();
    // Portfolio reconciliation is started at ArgusCoreBoot (independent of Autobot) so an
    // interrupted-session entry hold can clear on in-process RECONCILIATION_MATCH without
    // requiring Autobot on. Idempotent if already started.
    portfolioReconciliationWorker.start();
    // No-ops unless ARGUS_OPPORTUNITY_LOOP_ENABLED=true (default false) - was previously never
    // constructed/started by any boot path at all (real defect: the flag existed but nothing ever
    // reached the code that checks it). Starting it here unconditionally is safe because the
    // worker's own start() re-checks the flag and returns immediately when it's off.
    opportunityDiscoveryWorker.start();
    newsEngine.start(); // clustering for news_veto; NewsAgent ideas gated separately
    reflectionEngine.start();
    predictionOutcomeEvaluator.start();
    trainingExampleBuilder.start();
    systemMetricsWorker.start();
    dbBackupService.start();
    marketDataCrossChecker.start();
    marketRegimeAgent;
    explainabilityAgent;
    kronosEngine.initialize();
    startEnabledIdeaAgents();
    
    this.isRunning = true;
    console.log("[Argus System] All workers online.");
    console.log("===================================");
  }

  stop() {
    if (!this.isRunning) return;
    console.log("[Argus System] Shutting down workers...");
    
    // Market-data stays up when Autobot is toggled off so Diagnostics/RiskEngine still have a
    // real feed. Stopping it here made MD-001 fire whenever Autobot was idle even though keys
    // were set. marketDataWorker.stop() remains available for process shutdown.
    oms.stop();
    portfolioMonitor.stop();
    // Recon stays up when Autobot is off (same pattern as MarketDataWorker / NewsEngine) so
    // RECONCILIATION_MATCH can release the interrupted-session *entry* hold without enabling
    // Autobot. portfolioReconciliationWorker.stop() remains for process shutdown drain.
    opportunityDiscoveryWorker.stop();
    // NewsEngine stays up when Autobot is toggled off (same pattern as MarketDataWorker) so
    // news_veto clusters and Digital Twin NEWS_* telemetry keep refreshing. newsEngine.stop()
    // remains available for process shutdown via gracefulShutdown.
    stopAllIdeaAgents();
    reflectionEngine.stop();
    predictionOutcomeEvaluator.stop();
    trainingExampleBuilder.stop();
    systemMetricsWorker.stop();
    dbBackupService.stop();
    marketDataCrossChecker.stop();
    stopObservabilityRetentionSweep();
    stopProcessTelemetry();

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
