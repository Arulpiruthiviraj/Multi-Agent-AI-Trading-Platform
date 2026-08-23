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
import { EVENTS } from '../core/eventNames';
import { isTelemetryPulsePayload } from '../core/telemetryPulse';
import {
  formatAutobotDisabledLog,
  formatAutobotEnabledLog,
  formatChiefApprovedLog,
  formatDeskNoTradeLog,
  formatLearnedRuleLog,
  formatOrderExecutedLog,
  formatRiskAssessmentLog,
  formatTradeIdeaLog,
  type ActivityLogDetail,
} from '../core/activityLog';
import { db } from '../db';
import * as schema from '../db/schema';
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { system } from '../core/SystemBootstrap';
import { LIVE_TRADING_CONFIRMATION_PHRASE, armLiveTrading, disarmLiveTrading } from '../core/LiveTradingConfirmation';
import { tradingSafety } from '../config/tradingSafety';
import { normalizeStrategyFocus, strategyFocusConfig } from '../config/strategyFocus';
import { BrokerManager } from '../../brokers/BrokerManager';
import { TERMINAL_ORDER_STATUSES } from '../services/OrderManagement';
import {
  isPaperTradingOnlyEnforced,
  normalizeTradingMode,
  resolveEnvTradingMode,
} from '../core/tradingModeEnv';
import { isValidHHMM, isValidTimezone, isWithinScheduledWindow } from '../core/AutoTradeSchedule';
import { getTimeHHMMInZone, TRADING_TIMEZONE } from '../core/TradingCalendar';

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
    'autoTradeScheduleEnabled', 'autoTradeScheduleStartTime', 'autoTradeScheduleEndTime',
    'autoTradeScheduleTimezone',
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
    // AutoTradeScheduler.ts: when true, that background worker owns `enabled` and drives it
    // through this same toggle() on a timer instead of a human clicking Start/Stop.
    autoTradeScheduleEnabled: boolean;
    autoTradeScheduleStartTime: string; // "HH:MM", in autoTradeScheduleTimezone
    autoTradeScheduleEndTime: string; // "HH:MM", in autoTradeScheduleTimezone
    autoTradeScheduleTimezone: string; // IANA zone, e.g. "America/New_York" or "America/Toronto"
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
            strategy: strategyFocusConfig.defaultFocus || tradingSafety.defaultStrategyFocus,
            riskLevel: "Medium",
            maxTradeSize: 3000,
            dailyLossLimit: 5000,
            currentDailyLoss: 0,
            emergencyStopActive: false,
            tradingState: 'TRADING_ENABLED',
            dayStartEquity: null,
            dayStartDateStr: null,
            autoTradeScheduleEnabled: false,
            autoTradeScheduleStartTime: '09:30',
            autoTradeScheduleEndTime: '16:00',
            autoTradeScheduleTimezone: 'America/New_York',
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
        // Activity Log is this in-memory history. Listeners persist structured detail from
        // real EventBus payloads (agent/side/conf/gate/traceId) — no fabricated CoT.
        // Telemetry-pulse sequences are UI animation only and must not look like organic trades.
        eventBus.on(EVENTS.TRADE_IDEA_GENERATED, (idea) => {
           if (isTelemetryPulsePayload(idea)) return;
           const row = formatTradeIdeaLog(idea);
           this.logHistory(row.type, row.msg, row.detail);

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

        eventBus.on(EVENTS.CHIEF_APPROVED_IDEA, (idea) => {
           if (isTelemetryPulsePayload(idea)) return;
           const row = formatChiefApprovedLog(idea);
           this.logHistory(row.type, row.msg, row.detail);

           if (this.state.activeCycle?.symbol === idea.symbol) {
               this.state.activeCycle.status = 'verifying';
               this.state.activeCycle.proposerData = {
                   decision: idea.side,
                   confidence: typeof idea.confidence === 'number' ? Math.round(idea.confidence * 100) : undefined,
                   thinking: idea.reasoning
               };
           }
        });

        eventBus.on(EVENTS.DESK_NO_TRADE, (payload) => {
           if (isTelemetryPulsePayload(payload)) return;
           const row = formatDeskNoTradeLog(payload);
           this.logHistory(row.type, row.msg, row.detail);
        });

        eventBus.on(EVENTS.RISK_ASSESSMENT_COMPLETED, (assessment) => {
           if (isTelemetryPulsePayload(assessment)) return;
           const row = formatRiskAssessmentLog(assessment);
           this.logHistory(row.type, row.msg, row.detail);

           if (this.state.activeCycle?.symbol === assessment.symbol) {
               this.state.activeCycle.riskData = {
                   verdict: assessment.approved ? 'APPROVE' : 'REJECT',
                   thinking: assessment.reasoning
               };
               this.state.activeCycle.status = assessment.approved ? 'optimizing' : 'vetoed';
               if (!assessment.approved) this.state.activeCycle.finalAction = 'REJECTED';
           }
        });

        eventBus.on(EVENTS.ORDER_EXECUTED, (order) => {
           if (isTelemetryPulsePayload(order)) return;
           const row = formatOrderExecutedLog(order);
           this.logHistory(row.type, row.msg, row.detail);
           const qty = typeof order.quantity === 'number' ? order.quantity : 0;
           const price = typeof order.price === 'number' ? order.price : 0;
           if ((order.status || 'FILLED') === 'FILLED' || order.status === 'PARTIALLY_FILLED') {
               this.state.spent += qty * price;
           }

           if (this.state.activeCycle?.symbol === order.symbol) {
               this.state.activeCycle.status = 'executed';
               this.state.activeCycle.finalAction = 'EXECUTED';
               this.state.activeCycle.executionData = { strategy: `${order.side} MARKET` };
           }
        });
        
        eventBus.on(EVENTS.LEARNED_NEW_RULE, (rule) => {
           this.state.memoryRules.unshift(rule);
           if (this.state.memoryRules.length > 50) this.state.memoryRules.pop();
           const row = formatLearnedRuleLog(rule);
           this.logHistory(row.type, row.msg, row.detail);
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
    
    public logHistory(type: string, msg: string, detail?: ActivityLogDetail) {
       const eventTime = new Date().toISOString();
       const entry = detail ? { time: eventTime, type, msg, detail } : { time: eventTime, type, msg };
       this.state.history.unshift(entry);
       if (this.state.history.length > 200) this.state.history = this.state.history.slice(0, 200);
       
       try {
          // In-process ring for AutoBot UI; durable lifecycle is event_traces / Observatory.
          this.state.eventBus.unshift({
             id: "evt_" + Date.now(),
             type: type,
             source: "TradingEngine",
             timestamp: eventTime,
             payload: msg,
          });
          if (this.state.eventBus.length > 50) this.state.eventBus.pop();
       } catch (e) {}
    }

        public async initialize() {
        try {
            const envMode = resolveEnvTradingMode();
            const allSettings = await db.select().from(schema.settings).limit(1);
            if (allSettings.length > 0) {
                const s = allSettings[0];
                // ARGUS_TRADING_MODE preselects on boot so UI/.env agree; otherwise keep DB mode.
                // PAPER_TRADING_ONLY only demotes LIVE → PAPER (never wipes SIMULATOR).
                let resolvedMode = envMode.source === 'ARGUS_TRADING_MODE'
                  ? envMode.mode
                  : normalizeTradingMode(s.tradingMode || envMode.mode);
                if (resolvedMode === 'LIVE' && envMode.paperTradingOnly) {
                  resolvedMode = 'PAPER';
                }
                this.state.tradingMode = resolvedMode;
                this.state.riskLevel = s.riskLevel || "Balanced";
                this.state.budget = s.budget || 50000;
                this.state.strategy = normalizeStrategyFocus(s.strategy || strategyFocusConfig.defaultFocus);
                if (s.strategy !== this.state.strategy) {
                  await db.update(schema.settings).set({ strategy: this.state.strategy }).where(eq(schema.settings.id, s.id)).run();
                }
                this.state.maxTradeSize = s.maxTradeSize || tradingSafety.defaultMaxTradeSizeDollars;
                this.state.dailyLossLimit = s.dailyLossLimit || 5000;
                this.state.takeProfitPct = s.takeProfitPct || 15;
                this.state.trailingStopPct = s.trailingStopPct || 5;
                this.state.minAiConfidence = s.minAiConfidence || 75;
                this.state.adversarialDebateMode = s.adversarialDebateMode !== false;
                this.state.enabled = s.autoBotEnabled === true;
                this.state.autoTradeScheduleEnabled = s.autoTradeScheduleEnabled === true;
                this.state.autoTradeScheduleStartTime = isValidHHMM(s.autoTradeScheduleStartTime) ? s.autoTradeScheduleStartTime : '09:30';
                this.state.autoTradeScheduleEndTime = isValidHHMM(s.autoTradeScheduleEndTime) ? s.autoTradeScheduleEndTime : '16:00';
                this.state.autoTradeScheduleTimezone = isValidTimezone(s.autoTradeScheduleTimezone) ? s.autoTradeScheduleTimezone! : 'America/New_York';
                // Real fix this pass: the kill switch used to live only in memory
                // (emergencyStopActive on TradingEngine.state), so a process restart while
                // EMERGENCY_STOP was active silently resumed trading - defeating "require
                // explicit reactivation". Now loaded from the persisted settings row.
                this.state.tradingState = (s.tradingState as TradingState) || 'TRADING_ENABLED';
                this.state.emergencyStopActive = this.state.tradingState === 'EMERGENCY_STOP';
                if (this.state.tradingState !== 'TRADING_ENABLED') {
                    console.warn(`[TradingEngine] Restored from a non-enabled trading state: ${this.state.tradingState}. Explicit reactivation required.`);
                }
                if (normalizeTradingMode(s.tradingMode) !== this.state.tradingMode) {
                  await db.update(schema.settings).set({ tradingMode: this.state.tradingMode }).where(eq(schema.settings.id, s.id)).run();
                }

                console.log(`[TradingEngine] Initialized from SQLite settings (mode=${this.state.tradingMode}, envSource=${envMode.source})`);
            } else {
                this.state.tradingMode = envMode.mode;
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
                console.log(`[TradingEngine] Initialized default SQLite settings (mode=${this.state.tradingMode})`);
            }
            
            const { loadPipelineAgentEnabledFromDb } = await import('../core/pipelineAgentPersist');
            await loadPipelineAgentEnabledFromDb();

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

    /**
     * Whether AutoTradeScheduler currently wants Autobot on. Distinct from `state.enabled`:
     * a saved schedule can be on while the engine is off (outside the HH:MM window, or a
     * start-gate rejection). UI must not treat schedule-enabled as Autobot-running.
     */
    public getScheduleWindowStatus(): {
        scheduleEnabled: boolean;
        inWindow: boolean | null;
        startTime: string;
        endTime: string;
        timezone: string;
    } {
        const scheduleEnabled = this.state.autoTradeScheduleEnabled === true;
        const startTime = this.state.autoTradeScheduleStartTime;
        const endTime = this.state.autoTradeScheduleEndTime;
        const timezone = isValidTimezone(this.state.autoTradeScheduleTimezone)
            ? this.state.autoTradeScheduleTimezone
            : TRADING_TIMEZONE;
        if (!scheduleEnabled || !isValidHHMM(startTime) || !isValidHHMM(endTime)) {
            return { scheduleEnabled, inWindow: null, startTime, endTime, timezone };
        }
        const nowHHMM = getTimeHHMMInZone(new Date(), timezone);
        return {
            scheduleEnabled,
            inWindow: isWithinScheduledWindow(nowHHMM, startTime, endTime),
            startTime,
            endTime,
            timezone,
        };
    }

    public async toggle(config: Partial<AutoBotState> & { confirmLiveTrading?: string; autoBotEnabled?: boolean }): Promise<{ ok: boolean; error?: string }> {
        // Validated here (the one real entry point both /autobot/toggle and /config/settings go
        // through) rather than only at the route layer, so a bad value can never be silently
        // persisted and then silently skipped forever by AutoTradeScheduler.tick().
        for (const field of ['autoTradeScheduleStartTime', 'autoTradeScheduleEndTime'] as const) {
            if (Object.prototype.hasOwnProperty.call(config, field) && !isValidHHMM(config[field])) {
                return { ok: false, error: `${field} must be "HH:MM" 24-hour format, got ${JSON.stringify(config[field])}` };
            }
        }
        if (Object.prototype.hasOwnProperty.call(config, 'autoTradeScheduleTimezone') && !isValidTimezone(config.autoTradeScheduleTimezone)) {
            return { ok: false, error: `autoTradeScheduleTimezone is not a recognized IANA timezone: ${JSON.stringify(config.autoTradeScheduleTimezone)}` };
        }
        if (Object.prototype.hasOwnProperty.call(config, 'tradingMode') && config.tradingMode != null) {
            config.tradingMode = normalizeTradingMode(config.tradingMode);
        }
        // settings.autoBotEnabled is the DB column; in-memory state uses `enabled`. POST
        // /config/settings sends the DB name. Map it so both names drive the same lever —
        // otherwise the DB flag can flip without TradingEngine.state.enabled changing.
        if (!Object.prototype.hasOwnProperty.call(config, 'enabled')
            && Object.prototype.hasOwnProperty.call(config, 'autoBotEnabled')) {
            config.enabled = config.autoBotEnabled === true;
        }
        if (config.tradingMode === 'LIVE' && isPaperTradingOnlyEnforced()) {
            return {
              ok: false,
              error: 'Cannot enable LIVE while PAPER_TRADING_ONLY=true in .env. Set PAPER_TRADING_ONLY=false and restart, then confirm LIVE.',
            };
        }
        const goingLive = config.tradingMode === 'LIVE' && this.state.tradingMode !== 'LIVE';
        const goingPaper = (config.tradingMode === 'PAPER' || config.tradingMode === 'SIMULATOR') && this.state.tradingMode === 'LIVE';
        if (goingLive && config.confirmLiveTrading !== LIVE_TRADING_CONFIRMATION_PHRASE) {
            this.logHistory('veto', 'Blocked attempt to enable LIVE trading mode without explicit confirmation.');
            return { ok: false, error: `Enabling LIVE trading mode requires confirmLiveTrading: "${LIVE_TRADING_CONFIRMATION_PHRASE}"` };
        }
        if (goingLive && this.state.tradingState !== 'TRADING_ENABLED') {
            return { ok: false, error: `Cannot enable LIVE trading while tradingState is ${this.state.tradingState}. Resume via the kill-switch endpoint first.` };
        }
        // Real bug fixed: this budget-vs-buying-power check used to run AFTER armLiveTrading()
        // below, so a single call combining tradingMode:'LIVE', enabled:true, a too-large budget,
        // and the correct confirmLiveTrading phrase would arm live trading and THEN fail this
        // check - returning a clean { ok: false } while leaving the process-wide liveOrdersArmed
        // flag set with no rollback. An arm must only ever be a side effect of a call that fully
        // succeeds, never a call that gets rejected one check later. Moved before arm/disarm so a
        // rejected toggle() never has any side effect on the live-arm state.
        //
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

        if (goingLive) armLiveTrading(config.confirmLiveTrading);
        if (goingPaper) disarmLiveTrading();
        else if (
          Object.prototype.hasOwnProperty.call(config, 'tradingMode')
          && config.tradingMode !== 'LIVE'
          && this.state.tradingMode === 'LIVE'
        ) {
            disarmLiveTrading();
        }

        const wasEnabled = this.state.enabled;
        // Only an explicit allowlist of client-settable config fields is applied - see
        // TOGGLE_ALLOWED_FIELDS' comment for why this isn't a blanket Object.assign anymore.
        for (const field of TOGGLE_ALLOWED_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(config, field)) {
                (this.state as any)[field] = (config as any)[field];
            }
        }
        if (Object.prototype.hasOwnProperty.call(config, 'strategy')) {
            this.state.strategy = normalizeStrategyFocus(this.state.strategy);
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
                adversarialDebateMode: this.state.adversarialDebateMode,
                autoTradeScheduleEnabled: this.state.autoTradeScheduleEnabled,
                autoTradeScheduleStartTime: this.state.autoTradeScheduleStartTime,
                autoTradeScheduleEndTime: this.state.autoTradeScheduleEndTime,
                autoTradeScheduleTimezone: this.state.autoTradeScheduleTimezone,
            }).run();
            console.log('[TradingEngine] SQLite settings updated after toggle.');
        } catch (e) {
            console.error('[TradingEngine] Failed to update SQLite settings', e);
        }
        
        if (this.state.enabled && !wasEnabled) {
            const row = formatAutobotEnabledLog(this.state);
            this.logHistory(row.type, row.msg, row.detail);
            system.start(this.state.tradingMode as any);
        } else if (!this.state.enabled && wasEnabled) {
            const row = formatAutobotDisabledLog();
            this.logHistory(row.type, row.msg, row.detail);
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
