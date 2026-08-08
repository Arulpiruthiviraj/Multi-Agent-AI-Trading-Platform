/**
 * ==========================================================
 * Module: types.ts
 * 
 * Purpose:
 * Core TypeScript types and interfaces for the Historical Replay & Backtesting Engine.
 * 
 * Responsibilities:
 * - Define all backtesting-related types
 * - Ensure type safety across replay system
 * - Document data structures
 * 
 * Dependencies:
 * - None (pure types)
 * 
 * Never:
 * - Import implementation code (types only)
 * - Use 'any' type without justification
 * ==========================================================
 */

// ==================== CORE ENUMS ====================

export enum TradingMode {
    LIVE = 'LIVE',           // Real broker, real money
    PAPER = 'PAPER',         // Paper broker, simulated fills  
    SHADOW = 'SHADOW',       // Live data, no execution, track predictions
    BACKTEST = 'BACKTEST'    // Historical data, simulated execution
}

export enum BacktestStatus {
    PENDING = 'PENDING',
    RUNNING = 'RUNNING',
    PAUSED = 'PAUSED',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
    CANCELLED = 'CANCELLED'
}

export enum ReplaySpeed {
    STEP = 0,          // Manual step-by-step
    REAL_TIME = 1,     // 1x speed
    FAST_2X = 2,       // 2x speed
    FAST_10X = 10,     // 10x speed
    FAST_50X = 50,     // 50x speed
    FAST_100X = 100,   // 100x speed
    FAST_1000X = 1000, // 1000x speed
    MAX = 999999       // As fast as possible
}

export enum ViolationType {
    LOOKAHEAD_BIAS = 'LOOKAHEAD_BIAS',
    INVALID_TIMESTAMP = 'INVALID_TIMESTAMP',
    MISSING_DATA = 'MISSING_DATA',
    DATA_INTEGRITY = 'DATA_INTEGRITY'
}

// ==================== DATA STRUCTURES ====================

export interface Candle {
    symbol: string;
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    vwap?: number;
    trades?: number;
}

export interface Quote {
    symbol: string;
    timestamp: Date;
    bid: number;
    ask: number;
    bidSize: number;
    askSize: number;
    last: number;
    lastSize: number;
}

export interface NewsArticle {
    id: string;
    publishedAt: Date;
    source: string;
    headline: string;
    summary?: string;
    url?: string;
    symbol?: string;
    sentiment?: number;      // -1 to 1
    credibility?: number;    // 0 to 1
    impact?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface FundamentalData {
    symbol: string;
    timestamp: Date;
    marketCap?: number;
    peRatio?: number;
    eps?: number;
    revenue?: number;
    profitMargin?: number;
    debtToEquity?: number;
}

export interface MacroData {
    timestamp: Date;
    indicator: string;       // e.g., 'FED_RATE', 'CPI', 'GDP'
    value: number;
    previous?: number;
    forecast?: number;
    impact?: 'LOW' | 'MEDIUM' | 'HIGH';
}

// ==================== BACKTEST SESSION ====================

export interface BacktestSessionConfig {
    name: string;
    description?: string;
    datasetId: string;
    
    // Time range
    startDate: Date;
    endDate: Date;
    
    // Capital
    initialCapital: number;
    
    // Trading config
    strategy: string;
    riskLevel: 'Low' | 'Medium' | 'High' | 'Aggressive';
    maxTradeSize: number;
    dailyLossLimit: number;
    
    // Agent config
    enabledAgents: {
        technical: boolean;
        news: boolean;
        kronos: boolean;
        fundamental: boolean;
        macro: boolean;
    };
    
    agentWeights?: {
        technical: number;
        news: number;
        kronos: number;
        fundamental: number;
        macro: number;
    };
    
    // AI config
    aiConsensusEnabled: boolean;
    minAiConfidence: number;
    adversarialDebateMode: boolean;
    
    // Execution config
    slippageModel: 'NONE' | 'FIXED_BPS' | 'VOLUME_BASED';
    slippageBps?: number;
    commissionPerShare?: number;
    
    // Metadata
    gitCommit?: string;
    modelVersions?: Record<string, string>;
}

export interface BacktestSession {
    id: string;
    config: BacktestSessionConfig;
    status: BacktestStatus;
    
    // Progress tracking
    currentTime?: Date;
    progress: number;        // 0-100
    
    // Results (populated when complete)
    metrics?: BacktestMetrics;
    
    // Timestamps
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    
    // Error tracking
    error?: string;
    violations: BacktestViolation[];
}

// ==================== PREDICTIONS ====================

export interface Prediction {
    id: string;
    sessionId: string;
    
    // Agent info
    agentId: string;
    agentType: 'technical' | 'news' | 'kronos' | 'fundamental' | 'macro' | 'chief';
    
    // Prediction details
    symbol: string;
    side: 'BUY' | 'SELL' | 'HOLD';
    confidence: number;      // 0-100
    
    // Timing
    timestamp: Date;
    horizon: number;         // prediction horizon in minutes
    
    // Price info
    entryPrice: number;
    targetPrice?: number;
    stopPrice?: number;
    
    // Context
    reasoning: string;
    features: Record<string, any>;  // Technical indicators, sentiment, etc.
}

export interface PredictionOutcome {
    predictionId: string;
    
    // Actual market outcome
    actualPrice: number;
    actualHigh: number;
    actualLow: number;
    actualReturn: number;    // Percentage return
    
    // Evaluation
    directionCorrect: boolean;
    profitable: boolean;
    
    // Excursions
    maxFavorableExcursion: number;  // Best price reached
    maxAdverseExcursion: number;     // Worst price reached
    
    // Timing
    evaluatedAt: Date;
    
    // Exit reason (if trade was actually taken)
    exitReason?: 'TARGET_HIT' | 'STOP_HIT' | 'TIME_EXIT' | 'MANUAL_EXIT';
}

// ==================== TRADES ====================

export interface BacktestTrade {
    id: string;
    sessionId: string;
    predictionId?: string;
    
    // Trade details
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    
    // Entry
    entryPrice: number;
    entryTime: Date;
    
    // Exit
    exitPrice?: number;
    exitTime?: Date;
    
    // Stops/Targets
    stopPrice?: number;
    targetPrice?: number;
    
    // Results
    pnl?: number;
    pnlPercent?: number;
    
    // Execution quality
    slippage?: number;
    commission?: number;
    
    // Status
    status: 'OPEN' | 'CLOSED' | 'STOPPED_OUT' | 'TARGET_HIT';
}

export interface Position {
    symbol: string;
    quantity: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    realizedPnl: number;
}

export interface Portfolio {
    cash: number;
    positions: Position[];
    totalValue: number;
    totalPnl: number;
    initialCapital: number;
}

// ==================== PERFORMANCE METRICS ====================

export interface BacktestMetrics {
    // Returns
    totalReturn: number;
    annualizedReturn: number;
    
    // Risk metrics
    sharpeRatio: number;
    sortinoRatio: number;
    calmarRatio: number;
    maxDrawdown: number;
    maxDrawdownDuration: number;  // days
    
    // Trade statistics
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    
    // P&L statistics
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    avgWinLossRatio: number;
    expectancy: number;
    
    // Duration statistics
    avgHoldingTime: number;  // minutes
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    
    // Prediction metrics
    totalPredictions: number;
    correctPredictions: number;
    predictionAccuracy: number;
    
    // Regression metrics (for price predictions)
    mae?: number;  // Mean Absolute Error
    rmse?: number; // Root Mean Squared Error
    mape?: number; // Mean Absolute Percentage Error
}

export interface AgentPerformance {
    agentId: string;
    agentType: string;
    
    // Predictions
    totalPredictions: number;
    correctPredictions: number;
    accuracy: number;
    
    // Returns (if agent's predictions were followed)
    avgReturn: number;
    sharpeRatio: number;
    
    // Contribution
    contributionScore: number;  // How much agent improved overall performance
    
    // By market regime
    performanceByRegime?: {
        bullMarket: number;
        bearMarket: number;
        sideways: number;
        highVolatility: number;
        lowVolatility: number;
    };
}

// ==================== DATA VALIDATION ====================

export interface BacktestViolation {
    id: string;
    sessionId: string;
    timestamp: Date;
    
    type: ViolationType;
    severity: 'WARNING' | 'ERROR' | 'CRITICAL';
    
    // Details
    agentId?: string;
    dataRequested?: string;
    dataTimestamp?: Date;
    currentTimestamp?: Date;
    
    message: string;
}

export interface ValidationResult {
    allowed: boolean;
    violation?: BacktestViolation;
}

export interface DataIntegrityReport {
    datasetId: string;
    
    // Coverage
    symbols: string[];
    startDate: Date;
    endDate: Date;
    totalCandles: number;
    
    // Quality metrics
    missingCandles: number;
    duplicateCandles: number;
    invalidOHLC: number;
    invalidVolume: number;
    gapsDetected: number;
    
    // By symbol
    symbolReports: {
        symbol: string;
        candles: number;
        missing: number;
        duplicates: number;
        quality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
    }[];
    
    // Overall
    overallQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
    readyForBacktest: boolean;
}

// ==================== WALK-FORWARD VALIDATION ====================

export interface WalkForwardConfig {
    trainingWindowDays: number;
    validationWindowDays: number;
    testWindowDays: number;
    stepSizeDays: number;
    
    // Anchored vs rolling window
    anchoredStart: boolean;  // If true, training always starts from initial date
}

export interface WalkForwardWindow {
    train: { start: Date; end: Date };
    validation: { start: Date; end: Date };
    test: { start: Date; end: Date };
}

export interface WalkForwardResults {
    windows: WalkForwardWindow[];
    
    // Training results
    trainingMetrics: BacktestMetrics[];
    
    // Validation results
    validationMetrics: BacktestMetrics[];
    
    // Out-of-sample test results
    testMetrics: BacktestMetrics[];
    
    // Aggregate stats
    avgTestReturn: number;
    avgTestSharpe: number;
    consistencyScore: number;  // How consistent across windows
    
    // Overfitting detection
    trainingVsTestGap: number;
    overfittingRisk: 'LOW' | 'MEDIUM' | 'HIGH';
}

// ==================== LEARNING & IMPROVEMENT ====================

export interface FailureAnalysis {
    tradeId: string;
    predictionId: string;
    
    // What happened
    predictedSide: 'BUY' | 'SELL' | 'HOLD';
    actualReturn: number;
    loss: number;
    
    // Why it failed
    contributingFactors: {
        technicalSignal: string;
        newsSignal: string;
        kronosSignal: string;
        consensusDecision: string;
    };
    
    // What could have been done differently
    correctSignals: string[];
    incorrectSignals: string[];
    
    // Regime context
    marketRegime: string;
    volatilityLevel: string;
    
    // Lesson learned
    proposedRule: string;
    confidence: number;
}

export interface LearningInsight {
    id: string;
    sessionId: string;
    
    type: 'RULE' | 'WEIGHT_ADJUSTMENT' | 'STRATEGY_CHANGE';
    
    // Insight
    insight: string;
    evidence: any;
    confidence: number;
    
    // Proposed change
    proposedChange: {
        type: string;
        before: any;
        after: any;
    };
    
    // Validation
    backtestProof?: {
        beforeMetrics: BacktestMetrics;
        afterMetrics: BacktestMetrics;
        improvement: number;
    };
    
    // Status
    status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'APPLIED';
    approvedBy?: string;
    appliedAt?: Date;
}

// ==================== EXPERIMENT COMPARISON ====================

export interface ExperimentComparison {
    experiments: {
        id: string;
        name: string;
        config: BacktestSessionConfig;
        metrics: BacktestMetrics;
    }[];
    
    // Statistical comparison
    bestExperiment: string;
    statisticalSignificance: boolean;
    
    // What changed
    differences: {
        parameter: string;
        values: any[];
        impact: number;
    }[];
}

// ==================== SHADOW MODE ====================

export interface ShadowPrediction {
    id: string;
    timestamp: Date;
    
    // What Argus predicted
    prediction: Prediction;
    
    // What would have been executed
    wouldExecute: boolean;
    wouldExecuteQuantity?: number;
    
    // Actual market outcome (evaluated later)
    outcome?: PredictionOutcome;
    
    // Live vs prediction comparison
    livePrice: number;
    predictionPrice: number;
    priceDeviation: number;
}

export interface ShadowSession {
    id: string;
    startTime: Date;
    endTime?: Date;
    
    predictions: ShadowPrediction[];
    
    // Aggregate performance
    accuracy: number;
    hypotheticalReturn: number;
    
    // Confidence calibration
    calibrationCurve: {
        confidenceBucket: number;
        actualAccuracy: number;
        count: number;
    }[];
}

// ==================== REPLAY CONTROL ====================

export interface ReplayState {
    sessionId: string;
    
    // Time control
    currentTime: Date;
    speed: ReplaySpeed;
    paused: boolean;
    
    // Progress
    startTime: Date;
    endTime: Date;
    progress: number;  // 0-100
    
    // Market state
    currentCandle?: Candle;
    portfolio: Portfolio;
    
    // Agent states
    agentSignals: {
        agentId: string;
        signal: 'BUY' | 'SELL' | 'HOLD';
        confidence: number;
    }[];
    
    // Consensus
    consensusDecision?: 'BUY' | 'SELL' | 'HOLD';
    consensusConfidence?: number;
    
    // Execution
    lastTrade?: BacktestTrade;
}

// ==================== EXPORT ALL ====================

export type {
    // Keep all types exported for easy imports
};
