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
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { system } from '../core/SystemBootstrap';
import { LIVE_TRADING_CONFIRMATION_PHRASE, armLiveTrading, disarmLiveTrading } from '../core/LiveTradingConfirmation';
import { tradingSafety } from '../config/tradingSafety';
import { BrokerManager } from '../../brokers/BrokerManager';
import { TERMINAL_ORDER_STATUSES } from '../services/OrderManagement';

export type TradingState = 'TRADING_ENABLED' | 'TRADING_PAUSED' | 'EMERGENCY_STOP';

// Fields a client is allowed to change via the generic toggle()/config-update path. Deliberately
// excludes tradingState/emergencyStopActive (must go through setTradingState(), which is
// audited), history/eventBus/activeCycle/etc (internal, derived, or event-driven state, not
// client-settable config), and anything else not listed here. Real bug found and fixed this
// pass: toggle() used to do `Object.assign(this.state, req.body)` with zero allowlisting, so a
// client could silently clear an emergency stop (or wipe the activity history) via
// POST /api/v1/autobot/toggle instead of the dedicated, audited kill-switch endpoints.
const TOGGLE_ALLOWED_FIELDS: (keyof AutoBotState)[] = [
    'enabled', 'tradingMode', 'budget', 'strategy', 'riskLevel', 'maxTradeSize',
    'dailyLossLimit', 'takeProfitPct', 'trailingStopPct', 'minAiConfidence', 'adversarialDebateMode',
];

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
    tradingState: TradingState;
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
            tradingState: 'TRADING_ENABLED',
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
                regime: "BULLISH_TRENDS",
                adx: 25.5,
                volatilityRatio: 1.05,
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
                this.state.maxTradeSize = s.maxTradeSize || tradingSafety.defaultMaxTradeSizeDollars;
                this.state.dailyLossLimit = s.dailyLossLimit || 5000;
                this.state.takeProfitPct = s.takeProfitPct || 15;
                this.state.trailingStopPct = s.trailingStopPct || 5;
                this.state.minAiConfidence = s.minAiConfidence || 75;
                this.state.adversarialDebateMode = s.adversarialDebateMode !== false;
                this.state.enabled = s.autoBotEnabled === true;
                // Real fix this pass: the kill switch used to live only in memory
                // (emergencyStopActive on TradingEngine.state), so a process restart while
                // EMERGENCY_STOP was active silently resumed trading - defeating "require
                // explicit reactivation". Now loaded from the persisted settings row.
                this.state.tradingState = (s.tradingState as TradingState) || 'TRADING_ENABLED';
                this.state.emergencyStopActive = this.state.tradingState === 'EMERGENCY_STOP';
                if (this.state.tradingState !== 'TRADING_ENABLED') {
                    console.warn(`[TradingEngine] Restored from a non-enabled trading state: ${this.state.tradingState}. Explicit reactivation required.`);
                }

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

    public async toggle(config: Partial<AutoBotState> & { confirmLiveTrading?: string }): Promise<{ ok: boolean; error?: string }> {
        const goingLive = config.tradingMode === 'LIVE' && this.state.tradingMode !== 'LIVE';
        const goingPaper = config.tradingMode === 'Paper' && this.state.tradingMode === 'LIVE';
        if (goingLive && config.confirmLiveTrading !== LIVE_TRADING_CONFIRMATION_PHRASE) {
            this.logHistory('veto', 'Blocked attempt to enable LIVE trading mode without explicit confirmation.');
            return { ok: false, error: `Enabling LIVE trading mode requires confirmLiveTrading: "${LIVE_TRADING_CONFIRMATION_PHRASE}"` };
        }
        if (goingLive && this.state.tradingState !== 'TRADING_ENABLED') {
            return { ok: false, error: `Cannot enable LIVE trading while tradingState is ${this.state.tradingState}. Resume via the kill-switch endpoint first.` };
        }
        if (goingLive) armLiveTrading(config.confirmLiveTrading);
        if (goingPaper) disarmLiveTrading();
        else if (
          Object.prototype.hasOwnProperty.call(config, 'tradingMode')
          && config.tradingMode !== 'LIVE'
          && this.state.tradingMode === 'LIVE'
        ) {
            disarmLiveTrading();
        }

        // Allocated budget must not exceed what the active broker actually reports as available -
        // otherwise the bot starts "funded" on paper against capital that isn't really there. Only
        // checked on the enable transition (not on every config edit while already running), and
        // against the budget this call is actually about to apply, not whatever was previously set.
        const enabling = config.enabled === true && !this.state.enabled;
        if (enabling) {
            const targetBudget = Object.prototype.hasOwnProperty.call(config, 'budget') ? (config.budget as number) : this.state.budget;
            const broker = BrokerManager.getInstance().getActiveBroker();
            try {
                const portfolio = await broker.portfolio();
                const availableToTrade = portfolio.buyingPower ?? portfolio.cash ?? 0;
                if (targetBudget > availableToTrade) {
                    const msg = `Allocated fund ($${targetBudget.toLocaleString()}) exceeds ${broker.name}'s available buying power ($${availableToTrade.toLocaleString(undefined, { maximumFractionDigits: 2 })}). Deposit more funds with ${broker.name} to raise available buying power, or lower the allocated amount.`;
                    this.logHistory('veto', `Blocked start: ${msg}`);
                    return { ok: false, error: msg };
                }
            } catch (e: any) {
                const msg = `Could not verify ${broker.name}'s available funds before starting: ${e.message}`;
                this.logHistory('veto', `Blocked start: ${msg}`);
                return { ok: false, error: msg };
            }
        }

        const wasEnabled = this.state.enabled;
        // Only an explicit allowlist of client-settable config fields is applied - see
        // TOGGLE_ALLOWED_FIELDS' comment for why this isn't a blanket Object.assign anymore.
        for (const field of TOGGLE_ALLOWED_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(config, field)) {
                (this.state as any)[field] = (config as any)[field];
            }
        }

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

        if (goingLive) {
            this.logHistory('start', 'LIVE trading mode enabled with explicit confirmation.');
        }

        return { ok: true };
    }

    /**
     * The one path that may change tradingState/emergencyStopActive. Real trading-safety kill
     * switch (Phase 1.4): TRADING_ENABLED -> TRADING_PAUSED|EMERGENCY_STOP blocks all new trades
     * (RiskEngine's emergency_stop gate checks tradingState, not just the legacy boolean).
     * EMERGENCY_STOP additionally cancels real outstanding broker orders when cancelOpenOrders
     * is requested; existing filled positions are never touched by this method. Every transition
     * is persisted to `settings.tradingState` (survives a restart) and appended to the immutable
     * `kill_switch_events` audit table (distinct from the ephemeral in-memory activity history).
     */
    public async setTradingState(
        newState: TradingState,
        opts: { reason: string; actor: string; cancelOpenOrders?: boolean }
    ): Promise<{ ok: true; fromState: TradingState; toState: TradingState; cancelledOrderIds: string[] }> {
        const fromState = this.state.tradingState;
        this.state.tradingState = newState;
        this.state.emergencyStopActive = newState === 'EMERGENCY_STOP'; // kept in sync for RiskEngine/UI back-compat

        let cancelledOrderIds: string[] = [];
        if (newState === 'EMERGENCY_STOP' && opts.cancelOpenOrders) {
            cancelledOrderIds = await this.cancelAllOpenOrders();
        }

        const verb = newState === 'TRADING_ENABLED' ? 'start' : 'veto';
        this.logHistory(verb, `Trading state: ${fromState} -> ${newState}. Reason: ${opts.reason}${cancelledOrderIds.length ? ` (cancelled ${cancelledOrderIds.length} open order(s))` : ''}`);

        // Phase 12 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - previously this method emitted no real
        // event at all, so nothing could subscribe to a real kill-switch transition without polling
        // `tradingEngine.state` directly. Real, additive - AlertingService.ts is the first real
        // consumer, but this is generically useful, not alerting-specific.
        eventBus.emit('TRADING_STATE_CHANGED', { fromState, toState: newState, reason: opts.reason, actor: opts.actor, cancelledOrderIds });

        try {
            await db.update(schema.settings).set({ tradingState: newState }).run();
        } catch (e) {
            console.error('[TradingEngine] Failed to persist tradingState to settings', e);
        }

        try {
            await db.insert(schema.killSwitchEvents).values({
                fromState,
                toState: newState,
                reason: opts.reason,
                actor: opts.actor,
                cancelledOrderIds: JSON.stringify(cancelledOrderIds),
                createdAt: new Date().toISOString(),
            });
        } catch (e) {
            console.error('[TradingEngine] Failed to persist kill-switch audit event', e);
        }

        return { ok: true, fromState, toState: newState, cancelledOrderIds };
    }

    /** Cancels real outstanding (unfilled) broker orders. Never touches filled positions. */
    private async cancelAllOpenOrders(): Promise<string[]> {
        const cancelled: string[] = [];
        try {
            const broker = BrokerManager.getInstance().getActiveBroker();
            // Hardening pass, Phase 2: previously only matched the literal status 'PENDING' -
            // real broker adapters (Alpaca) can report other non-terminal statuses ('NEW',
            // 'ACCEPTED', 'PARTIALLY_FILLED', ...) that were silently excluded from this query.
            // TERMINAL_ORDER_STATUSES is the same set OrderManagementService's own follow-up job
            // uses, so "still open" means the same thing in both places.
            const openTrades = await db.select().from(schema.trades)
                .where(and(notInArray(schema.trades.status, TERMINAL_ORDER_STATUSES), isNotNull(schema.trades.brokerOrderId)));
            for (const t of openTrades) {
                if (!t.brokerOrderId) continue;
                try {
                    const ok = await broker.cancelOrder(t.brokerOrderId);
                    if (ok) {
                        cancelled.push(t.brokerOrderId);
                        // Previously left this row at its stale pre-cancel status forever - the
                        // broker-side cancellation was real, but Argus's own record of it wasn't.
                        try {
                            await db.update(schema.trades).set({ status: 'CANCELED' }).where(eq(schema.trades.id, t.id));
                        } catch (e) {
                            console.error(`[TradingEngine] Cancelled order ${t.brokerOrderId} at the broker but failed to update its trades row`, e);
                        }
                    }
                } catch (e) {
                    console.error(`[TradingEngine] Failed to cancel order ${t.brokerOrderId}`, e);
                }
            }
        } catch (e) {
            console.error('[TradingEngine] cancelAllOpenOrders failed', e);
        }
        return cancelled;
    }
}

export const tradingEngine = TradingEngine.getInstance();
