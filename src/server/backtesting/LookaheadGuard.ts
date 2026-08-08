/**
 * ==========================================================
 * Module: LookaheadGuard.ts
 * 
 * Purpose:
 * CRITICAL COMPONENT: Prevents look-ahead bias in backtesting.
 * Validates that no future information is accessed during historical replay.
 * 
 * This is the most important safeguard in the backtesting system.
 * Every historical data access MUST pass through this guard.
 * 
 * Responsibilities:
 * - Validate all data access against current replay time
 * - Detect and log look-ahead bias violations
 * - Block future data access attempts
 * - Generate violation reports
 * 
 * Inputs:
 * - Data timestamp, current replay time
 * 
 * Outputs:
 * - Validation result (allow/block)
 * - Violation report if blocked
 * 
 * Emits:
 * - LOOKAHEAD_VIOLATION_DETECTED
 * 
 * Dependencies:
 * - TimeSource (for current time)
 * - EventBus (for violation events)
 * 
 * Called By:
 * - All historical data providers
 * - Market data queries
 * - News queries
 * - Fundamental/macro data queries
 * 
 * Never:
 * - Allow data where dataTimestamp > currentReplayTime
 * - Silently pass violations
 * - Be disabled in production backtests
 * 
 * ==========================================================
 */

import { timeSourceManager, isBacktesting } from './TimeSource';
import { eventBus } from '../core/EventBus';
import { 
    ViolationType, 
    BacktestViolation, 
    ValidationResult 
} from './types';
import { db } from '../db';
import * as schema from '../db/schema';

export class LookaheadGuard {
    private sessionId: string;
    private violations: BacktestViolation[] = [];
    private strictMode: boolean;
    
    constructor(sessionId: string, strictMode: boolean = true) {
        this.sessionId = sessionId;
        this.strictMode = strictMode;
    }
    
    /**
     * Validate data access against current replay time
     * This is the CORE method that prevents look-ahead bias
     */
    validateDataAccess(
        dataTimestamp: Date,
        context: {
            dataType: string;
            symbol?: string;
            agentId?: string;
            requestedBy?: string;
        }
    ): ValidationResult {
        // Skip validation in live trading mode
        if (!isBacktesting()) {
            return { allowed: true };
        }
        
        const currentTime = timeSourceManager.getCurrentTime();
        
        // Check if data timestamp is in the future
        if (dataTimestamp > currentTime) {
            const violation = this.createViolation(
                ViolationType.LOOKAHEAD_BIAS,
                'CRITICAL',
                dataTimestamp,
                currentTime,
                context
            );
            
            this.logViolation(violation);
            
            // In strict mode, block access
            if (this.strictMode) {
                return {
                    allowed: false,
                    violation
                };
            } else {
                // In non-strict mode, warn but allow
                console.warn(`[LOOKAHEAD WARNING] ${violation.message}`);
                return {
                    allowed: true,
                    violation
                };
            }
        }
        
        return { allowed: true };
    }
    
    /**
     * Validate a batch of data (e.g., candles, news articles)
     * Returns filtered data with only valid timestamps
     */
    validateBatch<T extends { timestamp: Date }>(
        data: T[],
        context: {
            dataType: string;
            symbol?: string;
            agentId?: string;
        }
    ): { valid: T[]; violations: BacktestViolation[] } {
        if (!isBacktesting()) {
            return { valid: data, violations: [] };
        }
        
        const currentTime = timeSourceManager.getCurrentTime();
        const valid: T[] = [];
        const violations: BacktestViolation[] = [];
        
        for (const item of data) {
            if (item.timestamp <= currentTime) {
                valid.push(item);
            } else {
                const violation = this.createViolation(
                    ViolationType.LOOKAHEAD_BIAS,
                    'WARNING',
                    item.timestamp,
                    currentTime,
                    {
                        ...context,
                        dataItem: JSON.stringify(item).substring(0, 200)
                    }
                );
                
                violations.push(violation);
            }
        }
        
        // Log if violations found
        if (violations.length > 0) {
            console.warn(`[LOOKAHEAD GUARD] Filtered ${violations.length} future items from ${context.dataType}`);
            
            // Log summary violation
            this.logViolation({
                ...violations[0],
                message: `Filtered ${violations.length} future ${context.dataType} items`
            });
        }
        
        return { valid, violations };
    }
    
    /**
     * Validate a timestamp is not in the future
     */
    validateTimestamp(
        timestamp: Date,
        context: {
            operation: string;
            agentId?: string;
        }
    ): ValidationResult {
        if (!isBacktesting()) {
            return { allowed: true };
        }
        
        const currentTime = timeSourceManager.getCurrentTime();
        
        if (timestamp > currentTime) {
            const violation = this.createViolation(
                ViolationType.INVALID_TIMESTAMP,
                'ERROR',
                timestamp,
                currentTime,
                context
            );
            
            this.logViolation(violation);
            
            return {
                allowed: false,
                violation
            };
        }
        
        return { allowed: true };
    }
    
    /**
     * Validate a time range query
     */
    validateTimeRange(
        startTime: Date,
        endTime: Date,
        context: {
            queryType: string;
            agentId?: string;
        }
    ): { allowed: boolean; adjustedEndTime?: Date; violation?: BacktestViolation } {
        if (!isBacktesting()) {
            return { allowed: true };
        }
        
        const currentTime = timeSourceManager.getCurrentTime();
        
        // Start time must not be in future
        if (startTime > currentTime) {
            const violation = this.createViolation(
                ViolationType.LOOKAHEAD_BIAS,
                'CRITICAL',
                startTime,
                currentTime,
                {
                    ...context,
                    rangeType: 'startTime'
                }
            );
            
            this.logViolation(violation);
            
            return {
                allowed: false,
                violation
            };
        }
        
        // If end time is in future, adjust it
        if (endTime > currentTime) {
            console.warn(`[LOOKAHEAD GUARD] Adjusted end time from ${endTime.toISOString()} to ${currentTime.toISOString()}`);
            
            return {
                allowed: true,
                adjustedEndTime: currentTime
            };
        }
        
        return { allowed: true };
    }
    
    /**
     * Create a violation record
     */
    private createViolation(
        type: ViolationType,
        severity: 'WARNING' | 'ERROR' | 'CRITICAL',
        dataTimestamp: Date,
        currentTimestamp: Date,
        context: any
    ): BacktestViolation {
        const violation: BacktestViolation = {
            id: `violation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            sessionId: this.sessionId,
            timestamp: currentTimestamp,
            type,
            severity,
            dataTimestamp,
            currentTimestamp,
            message: this.createViolationMessage(type, dataTimestamp, currentTimestamp, context),
            ...context
        };
        
        this.violations.push(violation);
        
        return violation;
    }
    
    /**
     * Create human-readable violation message
     */
    private createViolationMessage(
        type: ViolationType,
        dataTimestamp: Date,
        currentTimestamp: Date,
        context: any
    ): string {
        const timeDiffMs = dataTimestamp.getTime() - currentTimestamp.getTime();
        const timeDiffMinutes = Math.floor(timeDiffMs / 60000);
        const timeDiffHours = Math.floor(timeDiffMs / 3600000);
        
        let timeDesc = `${timeDiffMinutes} minutes`;
        if (timeDiffHours > 0) {
            timeDesc = `${timeDiffHours} hours`;
        }
        
        const base = `[${type}] Attempted to access data ${timeDesc} in the future`;
        const details = [
            `Current replay time: ${currentTimestamp.toISOString()}`,
            `Data timestamp: ${dataTimestamp.toISOString()}`,
            context.dataType && `Data type: ${context.dataType}`,
            context.symbol && `Symbol: ${context.symbol}`,
            context.agentId && `Agent: ${context.agentId}`,
            context.requestedBy && `Requested by: ${context.requestedBy}`
        ].filter(Boolean).join(', ');
        
        return `${base}. ${details}`;
    }
    
    /**
     * Log violation to database and emit event
     */
    private async logViolation(violation: BacktestViolation): Promise<void> {
        // Emit event immediately
        eventBus.publish('LOOKAHEAD_VIOLATION_DETECTED', violation);
        
        // Log to database asynchronously
        try {
            await db.insert(schema.backtestViolations).values({
                sessionId: violation.sessionId,
                timestamp: violation.timestamp.toISOString(),
                type: violation.type,
                severity: violation.severity,
                dataTimestamp: violation.dataTimestamp?.toISOString(),
                currentTimestamp: violation.currentTimestamp?.toISOString(),
                agentId: violation.agentId,
                dataRequested: violation.dataType,
                message: violation.message
            });
        } catch (error) {
            console.error('[LOOKAHEAD GUARD] Failed to log violation to database:', error);
        }
    }
    
    /**
     * Get all violations for this session
     */
    getViolations(): BacktestViolation[] {
        return [...this.violations];
    }
    
    /**
     * Get violation count by severity
     */
    getViolationStats(): {
        total: number;
        warnings: number;
        errors: number;
        critical: number;
    } {
        return {
            total: this.violations.length,
            warnings: this.violations.filter(v => v.severity === 'WARNING').length,
            errors: this.violations.filter(v => v.severity === 'ERROR').length,
            critical: this.violations.filter(v => v.severity === 'CRITICAL').length
        };
    }
    
    /**
     * Check if backtest should be failed due to violations
     */
    shouldFailBacktest(): boolean {
        const stats = this.getViolationStats();
        
        // Fail if any critical violations
        if (stats.critical > 0) {
            return true;
        }
        
        // Fail if too many errors
        if (stats.errors > 10) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Generate violation report
     */
    generateReport(): string {
        const stats = this.getViolationStats();
        
        if (stats.total === 0) {
            return '✅ No look-ahead violations detected';
        }
        
        const lines = [
            '⚠️ LOOK-AHEAD VIOLATION REPORT',
            '================================',
            `Total Violations: ${stats.total}`,
            `  Critical: ${stats.critical}`,
            `  Errors: ${stats.errors}`,
            `  Warnings: ${stats.warnings}`,
            '',
            'Recent Violations:',
            ''
        ];
        
        // Show last 10 violations
        const recent = this.violations.slice(-10);
        for (const v of recent) {
            lines.push(`[${v.severity}] ${v.message}`);
        }
        
        return lines.join('\n');
    }
}

/**
 * Global lookahead guard instance
 * Should be created per backtest session
 */
class LookaheadGuardManager {
    private static instance: LookaheadGuardManager;
    private currentGuard: LookaheadGuard | null = null;
    
    private constructor() {}
    
    public static getInstance(): LookaheadGuardManager {
        if (!LookaheadGuardManager.instance) {
            LookaheadGuardManager.instance = new LookaheadGuardManager();
        }
        return LookaheadGuardManager.instance;
    }
    
    public setGuard(guard: LookaheadGuard): void {
        this.currentGuard = guard;
    }
    
    public getGuard(): LookaheadGuard | null {
        return this.currentGuard;
    }
    
    public clearGuard(): void {
        this.currentGuard = null;
    }
}

export const lookaheadGuardManager = LookaheadGuardManager.getInstance();

/**
 * Convenience function for validation
 */
export function validateDataAccess(
    dataTimestamp: Date,
    context: {
        dataType: string;
        symbol?: string;
        agentId?: string;
    }
): ValidationResult {
    const guard = lookaheadGuardManager.getGuard();
    
    if (!guard) {
        // No guard active (live trading mode)
        return { allowed: true };
    }
    
    return guard.validateDataAccess(dataTimestamp, context);
}

/**
 * Convenience function for batch validation
 */
export function validateBatch<T extends { timestamp: Date }>(
    data: T[],
    context: {
        dataType: string;
        symbol?: string;
        agentId?: string;
    }
): { valid: T[]; violations: BacktestViolation[] } {
    const guard = lookaheadGuardManager.getGuard();
    
    if (!guard) {
        // No guard active (live trading mode)
        return { valid: data, violations: [] };
    }
    
    return guard.validateBatch(data, context);
}
