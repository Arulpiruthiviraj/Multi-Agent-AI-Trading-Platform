# Argus Historical Replay & Backtesting Architecture

## 🎯 Core Principle: REUSE, DON'T DUPLICATE

**Critical**: The backtesting system MUST reuse the existing Argus decision pipeline. The same agents, AIRouter, RiskEngine, and EventBus that power live trading must power historical replay.

---

## 🏗️ Architecture Overview

```
                    ┌────────────────────────┐
                    │   TIME SOURCE          │
                    │  (Pluggable)           │
                    └────────┬───────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
      ┌───────▼────────┐          ┌────────▼────────┐
      │  LIVE CLOCK    │          │ REPLAY CLOCK    │
      │  (system time) │          │ (historical T)  │
      └───────┬────────┘          └────────┬────────┘
              │                             │
              └──────────────┬──────────────┘
                             │
                    ┌────────▼───────────┐
                    │  DATA SOURCE       │
                    │  (Pluggable)       │
                    └────────┬───────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
      ┌───────▼────────┐          ┌────────▼────────────┐
      │ LIVE MARKET    │          │ HISTORICAL PROVIDER │
      │ (Alpaca WS)    │          │ (Time-filtered DB)  │
      └───────┬────────┘          └────────┬────────────┘
              │                             │
              └──────────────┬──────────────┘
                             │
                    ┌────────▼──────────────┐
                    │     EVENT BUS         │
                    │   (UNCHANGED)         │
                    └────────┬──────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    ┌────▼────┐      ┌──────▼─────┐      ┌─────▼────┐
    │Technical│      │    News    │      │  Kronos  │
    │ Agent   │      │   Agent    │      │  Agent   │
    └────┬────┘      └──────┬─────┘      └─────┬────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                    ┌────────▼──────────────┐
                    │   CHIEF TRADER        │
                    │   (UNCHANGED)         │
                    └────────┬──────────────┘
                             │
                    ┌────────▼──────────────┐
                    │   RISK ENGINE         │
                    │   (UNCHANGED)         │
                    └────────┬──────────────┘
                             │
                    ┌────────▼──────────────┐
                    │  EXECUTION ADAPTER    │
                    │   (Pluggable)         │
                    └────────┬──────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
      ┌───────▼────────┐          ┌────────▼────────────┐
      │  LIVE BROKER   │          │ BACKTEST SIMULATOR  │
      │  (Alpaca API)  │          │ (Deterministic)     │
      └───────┬────────┘          └────────┬────────────┘
              │                             │
              └──────────────┬──────────────┘
                             │
                    ┌────────▼──────────────┐
                    │ PREDICTION EVALUATOR  │
                    │ (Backtest only)       │
                    └────────┬──────────────┘
                             │
                    ┌────────▼──────────────┐
                    │ REFLECTION ENGINE     │
                    │   (UNCHANGED)         │
                    └───────────────────────┘
```

---

## 🔌 Pluggable Components

### 1. Time Source (NEW Interface)

```typescript
interface TimeSource {
    getCurrentTime(): Date;
    setSpeed(multiplier: number): void;  // For replay only
    pause(): void;
    resume(): void;
    jumpTo(timestamp: Date): void;       // For replay only
}

class LiveTimeSource implements TimeSource {
    getCurrentTime(): Date {
        return new Date();  // System time
    }
    // Other methods are no-ops
}

class ReplayTimeSource implements TimeSource {
    private currentTime: Date;
    private speed: number = 1;
    private paused: boolean = false;
    
    getCurrentTime(): Date {
        return new Date(this.currentTime);  // Historical time
    }
    
    advance(deltaMs: number): void {
        if (!this.paused) {
            this.currentTime = new Date(this.currentTime.getTime() + deltaMs * this.speed);
        }
    }
}
```

### 2. Data Source (NEW Interface)

```typescript
interface MarketDataSource {
    getCandles(symbol: string, start: Date, end: Date): Promise<Candle[]>;
    getQuote(symbol: string, at: Date): Promise<Quote>;
    getNews(symbol: string, start: Date, end: Date): Promise<NewsArticle[]>;
}

class LiveMarketDataSource implements MarketDataSource {
    // Connects to Alpaca WebSocket
}

class HistoricalMarketDataSource implements MarketDataSource {
    // Queries historical DB with time filter
    async getCandles(symbol: string, start: Date, end: Date): Promise<Candle[]> {
        // CRITICAL: Only return data where candle.timestamp <= end
        return db.query.historicalCandles.findMany({
            where: and(
                eq(historicalCandles.symbol, symbol),
                lte(historicalCandles.timestamp, end.toISOString())
            )
        });
    }
}
```

### 3. Execution Adapter (NEW Interface)

```typescript
interface ExecutionAdapter {
    submitOrder(order: Order): Promise<Fill>;
    getPosition(symbol: string): Promise<Position | null>;
    getPortfolio(): Promise<Portfolio>;
}

class LiveBrokerAdapter implements ExecutionAdapter {
    // Uses BrokerManager (Alpaca API)
}

class BacktestExecutionAdapter implements ExecutionAdapter {
    // Simulates fills deterministically
    async submitOrder(order: Order): Promise<Fill> {
        // Use actual historical prices at current replay timestamp
        const currentTime = timeSource.getCurrentTime();
        const quote = await dataSource.getQuote(order.symbol, currentTime);
        
        // Model realistic slippage/fees
        return this.simulateFill(order, quote);
    }
}
```

---

## 🚫 LookaheadGuard - CRITICAL COMPONENT

**Purpose**: Prevent future data leakage at every data access point.

```typescript
class LookaheadGuard {
    constructor(private timeSource: TimeSource) {}
    
    validateDataAccess(requestedData: any, dataTimestamp: Date): ValidationResult {
        const currentTime = this.timeSource.getCurrentTime();
        
        if (dataTimestamp > currentTime) {
            return {
                allowed: false,
                violation: {
                    type: 'LOOKAHEAD_BIAS',
                    requestedTime: dataTimestamp,
                    currentTime: currentTime,
                    violationMs: dataTimestamp.getTime() - currentTime.getTime()
                }
            };
        }
        
        return { allowed: true };
    }
}
```

**Integration Points**:
- Wrap ALL historical data providers
- Intercept EventBus emissions during replay
- Validate timestamp on every DB query
- Log violations to backtest report

---

## 📊 Prediction Evaluation System

```typescript
interface Prediction {
    id: string;
    sessionId: string;
    agentId: string;
    symbol: string;
    side: 'BUY' | 'SELL' | 'HOLD';
    confidence: number;
    timestamp: Date;
    entryPrice: number;
    targetPrice?: number;
    stopPrice?: number;
    horizon: number;  // minutes
    reasoning: string;
    features: Record<string, any>;
}

interface PredictionOutcome {
    predictionId: string;
    actualPrice: number;
    actualHigh: number;
    actualLow: number;
    actualReturn: number;
    directionCorrect: boolean;
    profitable: boolean;
    maxFavorableExcursion: number;
    maxAdverseExcursion: number;
    evaluatedAt: Date;
}

class PredictionEvaluator {
    async evaluate(prediction: Prediction): Promise<PredictionOutcome> {
        // Wait for horizon to pass
        const evalTime = new Date(prediction.timestamp.getTime() + prediction.horizon * 60000);
        
        // Get actual market outcome
        const candles = await dataSource.getCandles(
            prediction.symbol,
            prediction.timestamp,
            evalTime
        );
        
        const actualPrice = candles[candles.length - 1].close;
        const actualHigh = Math.max(...candles.map(c => c.high));
        const actualLow = Math.min(...candles.map(c => c.low));
        
        // Evaluate prediction
        return {
            predictionId: prediction.id,
            actualPrice,
            actualHigh,
            actualLow,
            actualReturn: (actualPrice - prediction.entryPrice) / prediction.entryPrice,
            directionCorrect: this.checkDirection(prediction, actualPrice),
            profitable: this.checkProfitable(prediction, actualPrice),
            maxFavorableExcursion: (actualHigh - prediction.entryPrice) / prediction.entryPrice,
            maxAdverseExcursion: (actualLow - prediction.entryPrice) / prediction.entryPrice,
            evaluatedAt: evalTime
        };
    }
}
```

---

## 🔄 Event Flow Comparison

### Live Trading
```
System Time (now)
  ↓
Alpaca WebSocket → MARKET_DATA event
  ↓
TechnicalAgent → TRADE_IDEA_GENERATED
  ↓
ChiefTrader → CHIEF_APPROVED_IDEA
  ↓
RiskEngine → RISK_ASSESSMENT_COMPLETED
  ↓
BrokerManager → ORDER_EXECUTED
  ↓
ReflectionEngine → LEARNED_NEW_RULE
```

### Historical Replay
```
Replay Time (2025-03-10 10:30:00)
  ↓
HistoricalProvider → MARKET_DATA event (SAME EVENT!)
  ↓
TechnicalAgent → TRADE_IDEA_GENERATED (SAME AGENT!)
  ↓
ChiefTrader → CHIEF_APPROVED_IDEA (SAME AGENT!)
  ↓
RiskEngine → RISK_ASSESSMENT_COMPLETED (SAME ENGINE!)
  ↓
BacktestSimulator → ORDER_EXECUTED (SAME EVENT!)
  ↓
ReflectionEngine → LEARNED_NEW_RULE (SAME ENGINE!)
  ↓
PredictionEvaluator → Measure outcome (NEW!)
```

**Key Insight**: The agents see IDENTICAL EventBus events. They don't know they're in a backtest.

---

## 📦 Database Schema

### New Tables

```sql
-- Backtest session metadata
CREATE TABLE backtest_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dataset_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    initial_capital REAL NOT NULL,
    config JSON NOT NULL,  -- Budget, risk, strategy, etc.
    git_commit TEXT,
    model_versions JSON,   -- {technical: "v1.2", kronos: "v0.8"}
    status TEXT,           -- running, completed, failed
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

-- Historical candle data
CREATE TABLE historical_candles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    dataset_id TEXT NOT NULL,
    UNIQUE(symbol, timestamp, dataset_id)
);

-- Historical news
CREATE TABLE historical_news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    published_at TEXT NOT NULL,
    source TEXT NOT NULL,
    headline TEXT NOT NULL,
    summary TEXT,
    url TEXT,
    symbol TEXT,
    sentiment REAL,
    credibility REAL,
    impact TEXT,
    dataset_id TEXT NOT NULL
);

-- Agent predictions during backtest
CREATE TABLE backtest_predictions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    confidence REAL NOT NULL,
    timestamp TEXT NOT NULL,
    entry_price REAL NOT NULL,
    target_price REAL,
    stop_price REAL,
    horizon INTEGER NOT NULL,
    reasoning TEXT,
    features JSON,
    FOREIGN KEY (session_id) REFERENCES backtest_sessions(id)
);

-- Prediction outcomes
CREATE TABLE backtest_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prediction_id TEXT NOT NULL,
    actual_price REAL NOT NULL,
    actual_high REAL NOT NULL,
    actual_low REAL NOT NULL,
    actual_return REAL NOT NULL,
    direction_correct INTEGER NOT NULL,
    profitable INTEGER NOT NULL,
    max_favorable_excursion REAL NOT NULL,
    max_adverse_excursion REAL NOT NULL,
    evaluated_at TEXT NOT NULL,
    FOREIGN KEY (prediction_id) REFERENCES backtest_predictions(id)
);

-- Simulated trades
CREATE TABLE backtest_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL,
    entry_time TEXT NOT NULL,
    exit_time TEXT,
    stop_price REAL,
    target_price REAL,
    pnl REAL,
    status TEXT,  -- open, closed, stopped
    FOREIGN KEY (session_id) REFERENCES backtest_sessions(id)
);

-- Performance metrics
CREATE TABLE backtest_metrics (
    session_id TEXT PRIMARY KEY,
    total_return REAL,
    annualized_return REAL,
    sharpe_ratio REAL,
    sortino_ratio REAL,
    max_drawdown REAL,
    win_rate REAL,
    profit_factor REAL,
    total_trades INTEGER,
    winning_trades INTEGER,
    losing_trades INTEGER,
    avg_win REAL,
    avg_loss REAL,
    expectancy REAL,
    FOREIGN KEY (session_id) REFERENCES backtest_sessions(id)
);

-- Agent performance breakdown
CREATE TABLE backtest_agent_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    total_predictions INTEGER NOT NULL,
    correct_predictions INTEGER NOT NULL,
    accuracy REAL NOT NULL,
    avg_return REAL,
    sharpe_ratio REAL,
    contribution_score REAL,
    FOREIGN KEY (session_id) REFERENCES backtest_sessions(id)
);

-- Lookahead violations (should be 0!)
CREATE TABLE backtest_violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    agent_id TEXT,
    violation_type TEXT NOT NULL,
    data_requested TEXT,
    data_timestamp TEXT,
    current_timestamp TEXT,
    FOREIGN KEY (session_id) REFERENCES backtest_sessions(id)
);
```

---

## 🎮 Operating Modes

```typescript
enum TradingMode {
    LIVE = 'LIVE',           // Real broker, real money
    PAPER = 'PAPER',         // Paper broker, simulated fills
    SHADOW = 'SHADOW',       // Live data, no execution, track predictions
    BACKTEST = 'BACKTEST'    // Historical data, simulated execution
}

class ArgusEngine {
    private timeSource: TimeSource;
    private dataSource: MarketDataSource;
    private executionAdapter: ExecutionAdapter;
    private mode: TradingMode;
    
    setMode(mode: TradingMode) {
        this.mode = mode;
        
        switch(mode) {
            case TradingMode.LIVE:
                this.timeSource = new LiveTimeSource();
                this.dataSource = new LiveMarketDataSource();
                this.executionAdapter = new LiveBrokerAdapter();
                break;
                
            case TradingMode.BACKTEST:
                this.timeSource = new ReplayTimeSource();
                this.dataSource = new HistoricalMarketDataSource();
                this.executionAdapter = new BacktestExecutionAdapter();
                break;
                
            case TradingMode.SHADOW:
                this.timeSource = new LiveTimeSource();
                this.dataSource = new LiveMarketDataSource();
                this.executionAdapter = new ShadowExecutionAdapter();  // Tracks but doesn't execute
                break;
        }
    }
}
```

---

## 🔬 Walk-Forward Validation

```typescript
interface WalkForwardConfig {
    trainingWindowDays: number;    // e.g., 180 days
    validationWindowDays: number;  // e.g., 30 days
    testWindowDays: number;        // e.g., 30 days
    stepSizeDays: number;          // e.g., 30 days (roll forward)
}

class WalkForwardEngine {
    async runValidation(config: WalkForwardConfig): Promise<ValidationResults> {
        const windows = this.generateWindows(config);
        const results = [];
        
        for (const window of windows) {
            // Train on training window (if model supports it)
            const trainedModel = await this.train(window.train);
            
            // Validate on validation window
            const valMetrics = await this.backtest(window.validation, trainedModel);
            
            // Test on out-of-sample test window
            const testMetrics = await this.backtest(window.test, trainedModel);
            
            results.push({ window, valMetrics, testMetrics });
        }
        
        return this.aggregateResults(results);
    }
}
```

---

## 🎯 Integration Checklist

### Phase 1: Infrastructure (Week 1)
- [ ] Create `src/server/backtesting/` directory
- [ ] Implement `TimeSource` interface + Live/Replay implementations
- [ ] Implement `MarketDataSource` interface + Live/Historical implementations
- [ ] Implement `ExecutionAdapter` interface + Live/Backtest implementations
- [ ] Create `LookaheadGuard` class
- [ ] Add database migrations for new tables

### Phase 2: Replay Engine (Week 2)
- [ ] Build `MarketReplayClock` with speed control
- [ ] Build `HistoricalReplayEngine` that emits EventBus events
- [ ] Build `HistoricalMarketDataProvider`
- [ ] Build `HistoricalNewsProvider`
- [ ] Integrate LookaheadGuard into all data access
- [ ] Test: Ensure TechnicalAgent receives identical events

### Phase 3: Execution & Evaluation (Week 3)
- [ ] Build `BacktestExecutionSimulator`
- [ ] Build `BacktestPortfolio` (tracks virtual positions)
- [ ] Build `PredictionEvaluator`
- [ ] Build `BacktestMetrics` calculator
- [ ] Test: End-to-end backtest with dummy data

### Phase 4: Validation & Learning (Week 4)
- [ ] Build `WalkForwardEngine`
- [ ] Build `AgentPerformanceAnalyzer`
- [ ] Build `FailureAnalysisEngine`
- [ ] Integrate with ReflectionEngine
- [ ] Test: Walk-forward validation

### Phase 5: API & UI (Week 5)
- [ ] Create `/api/backtest` routes
- [ ] Build Historical Replay dashboard
- [ ] Build Experiment Comparison UI
- [ ] Build Agent Performance Leaderboard
- [ ] Add replay controls (play, pause, speed, step)

---

## ⚠️ Critical Rules

1. **NEVER call `new Date()` inside agents during backtest**
   - Always use `timeSource.getCurrentTime()`

2. **NEVER access data without LookaheadGuard validation**
   - Every historical query must validate timestamp

3. **NEVER use `Math.random()` for financial outcomes**
   - Execution must be deterministic based on historical prices

4. **ALWAYS emit the SAME EventBus events**
   - Backtest and live must use identical event types

5. **NEVER auto-promote backtest weights to production**
   - Require explicit user approval

---

## 📈 Success Metrics

The implementation is complete when:

- ✅ Historical replay emits identical EventBus events as live trading
- ✅ All existing agents (Technical, News, Kronos, Chief, Risk) run during replay
- ✅ LookaheadGuard reports ZERO violations
- ✅ Every prediction receives an outcome evaluation
- ✅ Agent accuracy is calculated and displayed
- ✅ Walk-forward validation produces out-of-sample metrics
- ✅ UI shows replay progress with pause/play/speed controls
- ✅ Backtest results are reproducible (same inputs → same outputs)
- ✅ Production trading logic remains UNCHANGED

---

**This architecture ensures Argus can honestly answer: "Which agents actually work, and under what conditions?"**
