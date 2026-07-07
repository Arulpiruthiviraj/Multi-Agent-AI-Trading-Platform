from enum import Enum
from datetime import datetime
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field

class OrderSide(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"

class OrderType(str, Enum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"

class RegimeType(str, Enum):
    BULL_MARKET = "BULL_MARKET"
    BEAR_MARKET = "BEAR_MARKET"
    SIDEWAYS_MARKET = "SIDEWAYS_MARKET"
    HIGH_VOLATILITY = "HIGH_VOLATILITY"
    LOW_VOLATILITY = "LOW_VOLATILITY"

class TradeStatus(str, Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"

class AgentSignal(BaseModel):
    """
    Core Domain Signal produced by Intelligence and Quantitative agents
    """
    agent_id: str
    symbol: str
    signal: OrderSide
    confidence: float = Field(..., ge=0.0, le=1.0)
    reasoning: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=datetime.utcnow)

class Trade(BaseModel):
    """
    Domain Entity representing a trade order/execution
    """
    id: str
    symbol: str
    side: OrderSide
    order_type: OrderType
    quantity: float
    price: float
    total_amount: float
    status: TradeStatus
    agent_id_source: str
    thesis_summary: str
    executed_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)

class Position(BaseModel):
    """
    Domain Entity representing an active holding in the portfolio
    """
    symbol: str
    quantity: float
    entry_price: float
    current_price: float
    total_cost: float
    market_value: float
    unrealized_pnl: float
    unrealized_pnl_percent: float
    sector: str
    opened_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

class AgentPerformance(BaseModel):
    """
    Domain Entity representing the aggregated real-time accuracy and yield metrics of an AI agent
    """
    agent_id: str
    win_rate: float = 0.0
    loss_rate: float = 0.0
    sharpe_ratio: float = 0.0
    average_profit: float = 0.0
    average_loss: float = 0.0
    max_drawdown: float = 0.0
    accuracy: float = 0.0
    total_trades: int = 0
    current_weight: float = 1.0
    updated_at: datetime = Field(default_factory=datetime.utcnow)

class PortfolioSnapshot(BaseModel):
    """
    Historic Portfolio status snapshot for reporting, backtesting and drift checks
    """
    id: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    total_equity: float
    cash_balance: float
    positions_value: float
    unrealized_pnl: float
    daily_drawn_percent: float
    health_score: float # Portfolio health scoring from 0 to 100

class HistoricalEvent(BaseModel):
    """
    Stored historical events for structural similarity comparisons (Vector Memory DB)
    """
    id: str
    title: str
    description: str
    category: str # "election", "tariff", "war", "pandemic", "banking_crisis", "interest_rate_cycle", "commodity_shock"
    start_date: datetime
    end_date: Optional[datetime] = None
    market_impact_summary: str
    embedding: Optional[List[float]] = None # Vector embeddings
    metadata: Dict[str, Any] = Field(default_factory=dict)

class NarrativeTrend(str, Enum):
    STRENGTHENING = "STRENGTHENING"
    WEAKENING = "WEAKENING"
    EMERGING = "EMERGING"

class Narrative(BaseModel):
    """
    Aggregated public market narrative
    """
    id: str
    name: str # e.g. "Artificial Intelligence", "Nuclear Energy", "Semiconductors"
    trend: NarrativeTrend
    sentiment_score: float = Field(..., ge=-1.0, le=1.0)
    relevance_weight: float = Field(1.0, ge=0.1, le=10.0)
    source_count: int = 0
    last_discovered_at: datetime = Field(default_factory=datetime.utcnow)
    historical_growth_index: List[float] = Field(default_factory=list)

class RiskEvent(BaseModel):
    """
    Domain audit log representing a trade vetoed or modified by the Risk Layer
    """
    id: str
    symbol: str
    target_trade_id: str
    vetoed_by: str  # "exposure_agent", "drawdown_agent", "correlation_agent", "veto_coordinator"
    veto_reason: str
    original_trade_details: Dict[str, Any]
    action_taken: str # "FULL_VETO", "RESIZE", "DEFER"
    timestamp: datetime = Field(default_factory=datetime.utcnow)
