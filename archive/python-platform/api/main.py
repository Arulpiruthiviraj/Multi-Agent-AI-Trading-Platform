from fastapi import FastAPI, HTTPException, Query
from datetime import datetime
from typing import Dict, Any, List, Optional
from pydantic import BaseModel

from core.config import settings
from domain.entities import OrderSide, OrderType, TradeStatus
from portfolio.portfolio_manager import PortfolioManager
from broker.paper_broker import PaperTradingBroker
from services.trading_engine import MultiAgentTradingEngine

app = FastAPI(
    title="Multi-Agent AI Trading Platform API",
    description="Enterprise Multi-Agent Quantitative and Narrative Trading Platform",
    version="1.0.0"
)

# Core state singletons
portfolio_mgr = PortfolioManager(initial_cash=100000.0)
paper_broker = PaperTradingBroker()
paper_broker.connect()
engine = MultiAgentTradingEngine(portfolio_mgr, paper_broker)

# Pre-populate some historical activities to avoid empty screens
portfolio_mgr.add_position("AAPL", 50, 175.20, "Technology")
portfolio_mgr.add_position("NVDA", 40, 850.00, "Technology")
portfolio_mgr.add_position("GLD", 30, 210.00, "Safety Commodities")

@app.get("/api/v1/health")
def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "paper_trading_active": settings.PAPER_TRADING_ONLY,
        "environment": settings.ENV,
        "broker_connected": paper_broker.connected
    }

@app.get("/api/v1/portfolio")
def get_portfolio_summary():
    """Returns total assets valuation, cash balance and overall health scoring."""
    snapshot = portfolio_mgr.generate_snapshot()
    positions = portfolio_mgr.get_positions_list()
    return {
        "snapshot": snapshot.dict(),
        "positions": [p.dict() for p in positions]
    }

@app.get("/api/v1/signals")
def query_signals(symbol: str = "AAPL", sector: str = "Technology"):
    """
    Executes a real-time multi-agent valuation pass on the requested asset ticker.
    Synthesizes signals across technical, political, news and geopolitical streams.
    """
    # Dynamic price feed generator
    px_base = paper_broker.prices.get(symbol, 150.0)
    prices = [px_base * (1.0 + x * 0.005) for x in range(-20, 1)] # 20 historical candles
    volumes = [50000 + (x * 1234) for x in range(21)]

    context = {
        "news_headline": f"Tech stocks rebound on expectations of domestic manufacturing tax incentives for {symbol}.",
        "macro_interest_rate": 5.25,
        "macro_inflation_cpi": 3.1,
        "geopolitical_risk_index": 0.25,
        "political_tariffs_announced": False,
        "rates_rebounding": False
    }

    result = engine.evaluate_and_trade(symbol, sector, context, prices, volumes)
    return result

@app.get("/api/v1/trades")
def get_recent_trades():
    """Returns historical list of trades generated, executed or filled."""
    # Build list containing current active position elements as executions
    trades = []
    for pos in portfolio_mgr.get_positions_list():
        trades.append({
            "id": f"tr_hist_{pos.symbol.lower()}",
            "symbol": pos.symbol,
            "side": "BUY",
            "quantity": pos.quantity,
            "price": pos.entry_price,
            "total_amount": pos.total_cost,
            "status": "FILLED",
            "thesis": f"Initial core holding established for {pos.symbol}.",
            "timestamp": pos.opened_at.isoformat()
        })
    return trades

@app.get("/api/v1/risk")
def get_risk_vetos():
    """Returns log of trades intercepted and blocked by the FinalRiskVetoAgent."""
    # Push a dummy veto audit if list is currently empty to demonstrate mechanics
    if not engine.risk_veto.veto_history:
        engine.risk_veto._log_veto(
            symbol="NVDA",
            agent="exposure_agent",
            reason="Sector exposure breach. Sector 'Technology' would reach 38.2%, exceeding safety ceiling of 35.0%.",
            metadata={"allocated_amount": 10000.0}
        )
    return [v.dict() for v in engine.risk_veto.veto_history]

@app.get("/api/v1/agents")
def get_agent_weights():
    """Returns dynamic scoring casting weights per agent, adjusted per current regime."""
    # Obtain current weights optimized against outcome scores
    weights = engine.performance_manager.optimize_agent_weights()
    return {
        "weights": weights,
        "active_narratives": [
            {"name": "Artificial Intelligence", "trend": "STRENGTHENING", "sentiment": 0.85},
            {"name": "Defense Spending", "trend": "STRENGTHENING", "sentiment": 0.74},
            {"name": "Manufacturing Reshoring", "trend": "EMERGING", "sentiment": 0.45},
            {"name": "Rate Cuts", "trend": "WEAKENING", "sentiment": -0.20}
        ]
    }

@app.get("/api/v1/performance")
def get_performance_metrics():
    """Returns metrics per active neural agent (Win Rates, Sharpe Ratios, Drawdowns)."""
    # Return serial structures of registered managers
    data = {}
    for agent_id, perf in engine.performance_manager.perf_db.items():
        data[agent_id] = perf.dict()
    return data

@app.get("/api/v1/settings")
def get_system_settings():
    """Exposes core configuration values from centralized environments."""
    return {
        "DEFAULT_TRADE_SIZE": settings.DEFAULT_TRADE_SIZE,
        "MAX_TRADE_SIZE": settings.MAX_TRADE_SIZE,
        "MAX_DAILY_LOSS": settings.MAX_DAILY_LOSS,
        "MAX_WEEKLY_LOSS": settings.MAX_WEEKLY_LOSS,
        "MAX_SECTOR_EXPOSURE": settings.MAX_SECTOR_EXPOSURE,
        "MAX_POSITION_COUNT": settings.MAX_POSITION_COUNT,
        "MAX_TOTAL_DRAWDOWN": settings.MAX_TOTAL_DRAWDOWN,
        "PAPER_TRADING_ONLY": settings.PAPER_TRADING_ONLY,
        "ACTIVE_LLM_PROVIDER": engine.llm_service.p_name
    }

@app.get("/api/v1/event-memory")
def query_event_memory(query: str = Query("highly restrictive tariffs proposed affecting machinery and computer assemblies")):
    """
    Submits user text queries into similarity vector engines.
    Answering: 'Have we seen something similar before?'
    """
    context = engine.memory_service.generate_event_context(query)
    similar = engine.memory_service.search_similar_events(query, limit=2)
    return {
        "query": query,
        "summary": context,
        "matches": [
            {
                "score": float(m["score"]),
                "confidence": float(m["confidence"]),
                "title": m["event"].title,
                "category": m["event"].category,
                "description": m["event"].description,
                "impact": m["event"].market_impact_summary
            } for m in similar
        ]
    }
