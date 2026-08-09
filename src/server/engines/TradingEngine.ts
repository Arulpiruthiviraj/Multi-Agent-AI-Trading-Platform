/**
 * ==========================================================
 * Module:
 * TradingEngine.ts
 *
 * Purpose:
 * Core implementation and logic for the TradingEngine.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for TradingEngine
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
import { db } from '../db';
import * as schema from '../db/schema';
import { system } from '../core/SystemBootstrap';

export interface AutoBotState {
    enabled: boolean;
    tradingMode: string;
    budget: number;
    spent: number;
    strategy: string;
    riskLevel: string;
    maxTradeSize: number;
    dailyLossLimit: number;
    currentDailyLoss: number;
    takeProfitPct: number;
    trailingStopPct: number;
    minAiConfidence: number;
    adversarialDebateMode: boolean;
    intervalId: NodeJS.Timeout | null;
    history: any[];
    scheduledTasks: any[];
    cycleCount: number;
    activeMacroShock: any;
    engines: any;
    activeCycle: any;
    learningJournal: any[];
    memoryRules: any[];
    discoveredOpportunities: any[];
    equityHistory?: any[];
    workers?: any[];
    newsIntelligence?: any[];
    eventBus?: any[];
    orchestratorWorkflows?: any[];
    geneticPrompt?: any;
    bypassedTrades?: any[];
    regimeState?: any;
    emergencyStopActive: boolean;
    dayStartEquity: number | null;
    dayStartDateStr: string | null;
}

class TradingEngine {
    private static instance: TradingEngine;
    public state: AutoBotState;

    private constructor() {
        this.state = {
            enabled: false,
            tradingMode: "PAPER",
            budget: 50000,
            spent: 0,
            strategy: "Momentum Focus",
            riskLevel: "Medium",
            maxTradeSize: 3000,
            dailyLossLimit: 5000,
            currentDailyLoss: 0,
            emergencyStopActive: false,
            dayStartEquity: null,
            dayStartDateStr: null,
            takeProfitPct: 15,
            trailingStopPct: 5,
            minAiConfidence: 75,
            adversarialDebateMode: true,
            intervalId: null,
            history: [],
            scheduledTasks: [],
            cycleCount: 0,
            activeMacroShock: null,
            engines: {
                marketIntelligence: { vwap: 150.2, rvol: 1.4, gap: 0.5 },
                trend: { primary: "Bullish", strength: 80 },
                momentum: { rsi: 65, macd: "Bullish Cross" },
                news: { sentiment: 75, volume: "High" },
                verification: { active: true, aiConfidence: 85, engineConfidence: 90, verdict: "pending" }
            },
            // null until a real TRADE_IDEA_GENERATED event starts a cycle - AutoBotFlowVisualizer
            // shows its honest "Waiting for next scan cycle" state while this is null.
            activeCycle: null,
                        learningJournal: [],
            memoryRules: [],
            discoveredOpportunities: [],
            workers: [],
            newsIntelligence: [],
            eventBus: [],
            orchestratorWorkflows: [],
            equityHistory: [],
            bypassedTrades: [],
            geneticPrompt: {
                generation: 1,
                currentBestPrompt: "You are the Chief AI Trader. Review incoming signals...",
                performanceHistory: []
            },
            regimeState: {
                current: "Bullish Trends",
                volatility: "Low",
                detectedAt: new Date().toISOString()
            }
        };
// Listen to events to update state
        eventBus.on('TRADE_IDEA_GENERATED', (idea) => {
           this.logHistory('scan', `Agent proposed ${idea.side} on ${idea.symbol}`);

           // Start (or continue) the live decision-flow cycle shown by AutoBotFlowVisualizer.
           // Only real fields from the emitted idea are used - no fabricated stage data.
           if (!this.state.activeCycle || this.state.activeCycle.symbol !== idea.symbol || ['executed', 'vetoed', 'rejected'].includes(this.state.activeCycle.status)) {
               this.state.activeCycle = {
                   status: 'researching',
                   symbol: idea.symbol,
                   amount: this.state.maxTradeSize,
                   researchData: {
                       sentiment: idea.side === 'BUY' ? 'BULLISH' : idea.side === 'SELL' ? 'BEARISH' : 'NEUTRAL',
                       thinking: idea.reasoning
                   }
               };
           }
        });

        eventBus.on('CHIEF_APPROVED_IDEA', (idea) => {
           this.logHistory('scan', `Chief Trader approved ${idea.side} on ${idea.symbol} (Confidence: ${idea.confidence.toFixed(2)})`);

           if (this.state.activeCycle?.symbol === idea.symbol) {
               this.state.activeCycle.status = 'verifying';
               this.state.activeCycle.proposerData = {
                   decision: idea.side,
                   confidence: Math.round(idea.confidence * 100),
                   thinking: idea.reasoning
               };
           }
        });

        eventBus.on('RISK_ASSESSMENT_COMPLETED', (assessment) => {
           if (assessment.approved) {
               this.logHistory('execute', `Risk Engine approved ${assessment.symbol}. Executing ${assessment.maxQuantity} shares.`);
           } else {
               this.logHistory('veto', `Risk Engine vetoed ${assessment.symbol}: ${assessment.reasoning}`);
           }

           if (this.state.activeCycle?.symbol === assessment.symbol) {
               this.state.activeCycle.riskData = {
                   verdict: assessment.approved ? 'APPROVE' : 'REJECT',
                   thinking: assessment.reasoning
               };
               this.state.activeCycle.status = assessment.approved ? 'optimizing' : 'vetoed';
               if (!assessment.approved) this.state.activeCycle.finalAction = 'REJECTED';
           }
        });

        eventBus.on('ORDER_EXECUTED', (order) => {
           this.logHistory('execute', `Executed ${order.side} ${order.quantity}x ${order.symbol} @ $${order.price.toFixed(2)}`);
           this.state.spent += (order.quantity * order.price);

           if (this.state.activeCycle?.symbol === order.symbol) {
               this.state.activeCycle.status = 'executed';
               this.state.activeCycle.finalAction = 'EXECUTED';
               this.state.activeCycle.executionData = { strategy: `${order.side} MARKET` };
           }
        });
        
        eventBus.on('LEARNED_NEW_RULE', (rule) => {
           this.state.memoryRules.unshift(rule);
           if (this.state.memoryRules.length > 50) this.state.memoryRules.pop();
           this.logHistory('reflect', `Reflection Engine extracted rule: ${rule.rule}`);
        });
        
        eventBus.on('CALCULATION_COMPLETED', (calc) => {
           if (calc.engine === 'TechnicalEngine') {
               const { rsi, macd, sma20, sma50, currentPrice, bbUpper, bbLower } = calc.data;
               
               this.state.engines.momentum.rsi = rsi.toFixed(2);
               this.state.engines.momentum.macd = macd > 0 ? "Bullish Cross" : "Bearish Cross";
               
               const trendStr = currentPrice > sma50 ? "Bullish" : "Bearish";
               const strength = Math.abs(currentPrice - sma50) / sma50 * 100 * 10; // dummy strength calc
               
               this.state.engines.trend.primary = trendStr;
               this.state.engines.trend.strength = Math.min(100, Math.max(0, strength)).toFixed(1);
               this.state.engines.marketIntelligence.vwap = currentPrice.toFixed(2);
               this.state.engines.marketIntelligence.gap = ((currentPrice - sma20) / sma20 * 100).toFixed(2);
           }
        });
    }

    public static getInstance(): TradingEngine {
        if (!TradingEngine.instance) {
            TradingEngine.instance = new TradingEngine();
        }
        return TradingEngine.instance;
    }
    
    public logHistory(type: string, msg: string) {
       const eventTime = new Date().toISOString();
       this.state.history.unshift({ time: eventTime, type, msg });
       if (this.state.history.length > 100) this.state.history = this.state.history.slice(0, 100);
       
       try {
          // Changed to eventBus publish to handle schema constraints
          this.state.eventBus.unshift({
             id: "evt_" + Date.now(),
             type: type,
             source: "TradingEngine",
             timestamp: eventTime,
             payload: msg
          });
          if (this.state.eventBus.length > 50) this.state.eventBus.pop();
       } catch (e) {}
    }

        public async initialize() {
        try {
            const allSettings = await db.select().from(schema.settings).limit(1);
            if (allSettings.length > 0) {
                const s = allSettings[0];
                this.state.tradingMode = s.tradingMode || "PAPER";
                this.state.riskLevel = s.riskLevel || "Balanced";
                this.state.budget = s.budget || 50000;
                this.state.strategy = s.strategy || "Momentum Focus";
                this.state.maxTradeSize = s.maxTradeSize || 3000;
                this.state.dailyLossLimit = s.dailyLossLimit || 5000;
                this.state.takeProfitPct = s.takeProfitPct || 15;
                this.state.trailingStopPct = s.trailingStopPct || 5;
                this.state.minAiConfidence = s.minAiConfidence || 75;
                this.state.adversarialDebateMode = s.adversarialDebateMode !== false;
                this.state.enabled = s.autoBotEnabled === true;
                
                console.log('[TradingEngine] Initialized from SQLite settings');
            } else {
                await db.insert(schema.settings).values({
                    autoBotEnabled: this.state.enabled,
                    tradingMode: this.state.tradingMode,
                    budget: this.state.budget,
                    strategy: this.state.strategy,
                    riskLevel: this.state.riskLevel,
                    maxTradeSize: this.state.maxTradeSize,
                    dailyLossLimit: this.state.dailyLossLimit,
                    takeProfitPct: this.state.takeProfitPct,
                    trailingStopPct: this.state.trailingStopPct,
                    minAiConfidence: this.state.minAiConfidence,
                    adversarialDebateMode: this.state.adversarialDebateMode
                }).run();
                console.log('[TradingEngine] Initialized default SQLite settings');
            }
            
            if (this.state.enabled) {
                console.log('[TradingEngine] AutoBot enabled from prior state. Starting engines...');
                system.start(this.state.tradingMode as any);
            }
            
            const rules = await db.select().from(schema.memoryRules).orderBy(schema.memoryRules.createdAt);
            this.state.memoryRules = rules.map(r => ({ id: r.id, rule: r.ruleText, weight: r.weight, createdAt: r.createdAt }));
            
        } catch(e) {
            console.error('[TradingEngine] Failed to initialize from DB', e);
        }
    }

    public toggle(config: Partial<AutoBotState>) {
        const wasEnabled = this.state.enabled;
        Object.assign(this.state, config);
        
        try {
            db.update(schema.settings).set({
                autoBotEnabled: this.state.enabled,
                tradingMode: this.state.tradingMode,
                budget: this.state.budget,
                strategy: this.state.strategy,
                riskLevel: this.state.riskLevel,
                maxTradeSize: this.state.maxTradeSize,
                dailyLossLimit: this.state.dailyLossLimit,
                takeProfitPct: this.state.takeProfitPct,
                trailingStopPct: this.state.trailingStopPct,
                minAiConfidence: this.state.minAiConfidence,
                adversarialDebateMode: this.state.adversarialDebateMode
            }).run();
            console.log('[TradingEngine] SQLite settings updated after toggle.');
        } catch (e) {
            console.error('[TradingEngine] Failed to update SQLite settings', e);
        }
        
        if (this.state.enabled && !wasEnabled) {
            this.logHistory('start', `Autonomous bot ENABLED. Mode: ${this.state.tradingMode} | Budget: $${this.state.budget}`);
            system.start(this.state.tradingMode as any);
        } else if (!this.state.enabled && wasEnabled) {
            this.logHistory('stop', 'Autonomous bot DISABLED.');
            system.stop();
        }
    }
}

export const tradingEngine = TradingEngine.getInstance();
