/**
 * ==========================================================
 * Module: TimeSource.ts
 * 
 * Purpose:
 * Pluggable time source abstraction for live vs historical time control.
 * This is CRITICAL for backtesting - allows the entire system to be "time-traveled"
 * to any historical moment without modifying agent code.
 * 
 * Responsibilities:
 * - Provide current time (system time OR historical replay time)
 * - Control replay speed, pause, resume
 * - Enable deterministic time progression in backtests
 * 
 * Inputs:
 * - Speed multiplier, pause/resume commands
 * 
 * Outputs:
 * - Current time (Date object)
 * 
 * Emits:
 * - TIME_ADVANCED (for replay only)
 * - TIME_PAUSED
 * - TIME_RESUMED
 * 
 * Dependencies:
 * - EventBus (for time events)
 * 
 * Called By:
 * - All agents, data providers, execution adapters
 * 
 * Never:
 * - Call new Date() directly in agents (use timeSource.getCurrentTime() instead)
 * - Allow time to move backwards
 * 
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import { ReplaySpeed } from './types';

/**
 * Abstract time source interface
 * All code should depend on this interface, not concrete implementations
 */
export interface TimeSource {
    /**
     * Get current time (system time OR historical replay time)
     */
    getCurrentTime(): Date;
    
    /**
     * Set replay speed multiplier (replay only, no-op for live)
     */
    setSpeed(multiplier: ReplaySpeed): void;
    
    /**
     * Pause time progression (replay only, no-op for live)
     */
    pause(): void;
    
    /**
     * Resume time progression (replay only, no-op for live)
     */
    resume(): void;
    
    /**
     * Jump to specific timestamp (replay only, no-op for live)
     */
    jumpTo(timestamp: Date): void;
    
    /**
     * Check if currently paused (replay only, always false for live)
     */
    isPaused(): boolean;
    
    /**
     * Get current speed multiplier (replay only, always 1 for live)
     */
    getSpeed(): ReplaySpeed;
}

/**
 * Live time source - uses system time
 * Used for LIVE and PAPER trading modes
 */
export class LiveTimeSource implements TimeSource {
    getCurrentTime(): Date {
        return new Date();
    }
    
    setSpeed(multiplier: ReplaySpeed): void {
        // No-op for live trading
    }
    
    pause(): void {
        // No-op for live trading
    }
    
    resume(): void {
        // No-op for live trading
    }
    
    jumpTo(timestamp: Date): void {
        // No-op for live trading
        console.warn('Cannot jump time in live trading mode');
    }
    
    isPaused(): boolean {
        return false;  // Live trading never pauses
    }
    
    getSpeed(): ReplaySpeed {
        return ReplaySpeed.REAL_TIME;  // Always 1x
    }
}

/**
 * Replay time source - uses controlled historical time
 * Used for BACKTEST and SHADOW modes
 */
export class ReplayTimeSource implements TimeSource {
    private currentTime: Date;
    private speed: ReplaySpeed;
    private paused: boolean;
    private lastTickTime: number;  // System time of last tick
    
    constructor(startTime: Date, initialSpeed: ReplaySpeed = ReplaySpeed.REAL_TIME) {
        this.currentTime = new Date(startTime);
        this.speed = initialSpeed;
        this.paused = false;
        this.lastTickTime = Date.now();
    }
    
    getCurrentTime(): Date {
        // Return a copy to prevent external mutation
        return new Date(this.currentTime);
    }
    
    /**
     * Advance time by specified milliseconds
     * Called by the replay engine
     */
    advance(deltaMs: number): void {
        if (this.paused) {
            return;
        }
        
        if (deltaMs < 0) {
            throw new Error('Cannot advance time backwards');
        }
        
        const oldTime = new Date(this.currentTime);
        this.currentTime = new Date(this.currentTime.getTime() + deltaMs);
        this.lastTickTime = Date.now();
        
        // Emit time advanced event
        eventBus.publish('TIME_ADVANCED', {
            from: oldTime,
            to: this.currentTime,
            deltaMs,
            speed: this.speed
        });
    }
    
    /**
     * Tick the replay clock forward
     * Should be called regularly by the replay engine
     */
    tick(): void {
        if (this.paused || this.speed === ReplaySpeed.STEP) {
            return;
        }
        
        const now = Date.now();
        const systemDeltaMs = now - this.lastTickTime;
        
        // Apply speed multiplier
        const replayDeltaMs = systemDeltaMs * this.speed;
        
        this.advance(replayDeltaMs);
    }
    
    /**
     * Step forward by one market event (manual mode)
     */
    step(deltaMs: number = 1000): void {
        this.advance(deltaMs);
    }
    
    setSpeed(multiplier: ReplaySpeed): void {
        const oldSpeed = this.speed;
        this.speed = multiplier;
        this.lastTickTime = Date.now();  // Reset tick timer
        
        eventBus.publish('REPLAY_SPEED_CHANGED', {
            from: oldSpeed,
            to: multiplier
        });
    }
    
    pause(): void {
        if (this.paused) {
            return;
        }
        
        this.paused = true;
        
        eventBus.publish('REPLAY_PAUSED', {
            timestamp: this.currentTime
        });
    }
    
    resume(): void {
        if (!this.paused) {
            return;
        }
        
        this.paused = false;
        this.lastTickTime = Date.now();  // Reset tick timer
        
        eventBus.publish('REPLAY_RESUMED', {
            timestamp: this.currentTime
        });
    }
    
    jumpTo(timestamp: Date): void {
        if (timestamp < this.currentTime) {
            console.warn('Warning: Jumping backwards in time. This may cause inconsistent state.');
        }
        
        const oldTime = new Date(this.currentTime);
        this.currentTime = new Date(timestamp);
        this.lastTickTime = Date.now();
        
        eventBus.publish('REPLAY_JUMPED', {
            from: oldTime,
            to: this.currentTime
        });
    }
    
    isPaused(): boolean {
        return this.paused;
    }
    
    getSpeed(): ReplaySpeed {
        return this.speed;
    }
    
    /**
     * Get time until next market event
     * Used to optimize replay performance
     */
    getTimeUntilNextEvent(nextEventTime: Date): number {
        return nextEventTime.getTime() - this.currentTime.getTime();
    }
}

/**
 * Shadow time source - uses live time but tracks predictions
 * Used for SHADOW mode (live data, no execution)
 */
export class ShadowTimeSource extends LiveTimeSource {
    // Inherits all live behavior, but can add tracking hooks
    
    private predictionTimestamps: Date[] = [];
    
    getCurrentTime(): Date {
        const now = super.getCurrentTime();
        
        // Track when predictions are made
        this.predictionTimestamps.push(now);
        
        return now;
    }
    
    getPredictionTimestamps(): Date[] {
        return [...this.predictionTimestamps];
    }
}

/**
 * Global time source singleton
 * Should be injected into all components that need time
 */
class TimeSourceManager {
    private static instance: TimeSourceManager;
    private currentSource: TimeSource;
    
    private constructor() {
        // Default to live time
        this.currentSource = new LiveTimeSource();
    }
    
    public static getInstance(): TimeSourceManager {
        if (!TimeSourceManager.instance) {
            TimeSourceManager.instance = new TimeSourceManager();
        }
        return TimeSourceManager.instance;
    }
    
    public setSource(source: TimeSource): void {
        this.currentSource = source;
        
        eventBus.publish('TIME_SOURCE_CHANGED', {
            sourceType: source.constructor.name
        });
    }
    
    public getSource(): TimeSource {
        return this.currentSource;
    }
    
    /**
     * Convenience method - get current time from active source
     */
    public getCurrentTime(): Date {
        return this.currentSource.getCurrentTime();
    }
}

// Export singleton instance
export const timeSourceManager = TimeSourceManager.getInstance();

/**
 * Convenience function for getting current time
 * Use this throughout the codebase instead of new Date()
 */
export function getCurrentTime(): Date {
    return timeSourceManager.getCurrentTime();
}

/**
 * Convenience function for checking if in backtest mode
 */
export function isBacktesting(): boolean {
    const source = timeSourceManager.getSource();
    return source instanceof ReplayTimeSource;
}

/**
 * Convenience function for checking if paused
 */
export function isReplayPaused(): boolean {
    return timeSourceManager.getSource().isPaused();
}
