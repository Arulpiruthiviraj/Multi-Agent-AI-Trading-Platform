import pytest
from datetime import datetime
from domain.entities import OrderSide, OrderType, TradeStatus, AgentSignal
from services.event_memory_service import EventMemoryService
from portfolio.portfolio_manager import PortfolioManager
from broker.paper_broker import PaperTradingBroker
from risk.veto_agent import FinalRiskVetoAgent, PositionSizingAgent
from agents.decision_agents import BuyAgent, ConsensusAgent, ThesisAgent, SellValidationAgent

def test_event_memory_precedents():
    """Validates vector memory retrieval and semantic queries."""
    service = EventMemoryService()
    query = "tariff barriers raised by the administration on machinery commodities"
    
    similar = service.search_similar_events(query, limit=1)
    assert len(similar) > 0
    assert similar[0]["event"].category == "tariff"
    
    context = service.generate_event_context(query)
    assert "Sino-US Trade War" in context
    assert "Yes, we have seen a comparable scenario before." in context

def test_position_sizing_logic():
    """Asserts confidence curves scale allocations within limits."""
    sizer = PositionSizingAgent(default_size=100.0, max_size=500.0)
    
    # Low confidence resolves to low size
    size_low = sizer.calculate_size(confidence=0.55, symbol="AAPL", active_cash=10000.0)
    assert size_low == 80.0
    
    # High confidence resolves to premium size
    size_high = sizer.calculate_size(confidence=0.85, symbol="AAPL", active_cash=10000.0)
    assert size_high == 140.0
    
    # Cap limits
    size_capped = sizer.calculate_size(confidence=0.99, symbol="AAPL", active_cash=10000.0)
    assert size_capped <= 500.0

def test_risk_veto_sector_limits():
    """Verifies exposure agent blocks order if it would violate concentration limits."""
    # Strict limits set to 35%
    veto = FinalRiskVetoAgent(default_trade_size=100.0)
    
    # Pre-add positions to near limit (34% of 10k portfolio)
    positions = [
        # Establish Apple containing $3400 technology value
        type('PositionProxy', (object,), {
            "symbol": "AAPL",
            "quantity": 34.0,
            "entry_price": 100.0,
            "market_value": 3400.0,
            "sector": "technology"
        })()
    ]
    
    # Propose buy technology sector order that costs $500 (will exceed 35% concentration)
    cleared, t, msg = veto.vet_proposed_order(
        symbol="MSFT",
        side=OrderSide.BUY,
        confidence=0.80,
        sector="technology",
        active_cash=1000.0,
        active_positions=positions,
        total_portfolio_equity=10000.0,
        peak_portfolio_equity=10000.0
    )
    
    assert cleared is False
    assert "Sector exposure breach" in msg

def test_paper_trading_execution():
    """Validates simulated trading fills."""
    broker = PaperTradingBroker()
    broker.connect()
    
    trade = broker.execute_order(symbol="AAPL", side=OrderSide.BUY, order_type=OrderType.MARKET, quantity=10.0)
    assert trade.status == TradeStatus.FILLED
    assert trade.symbol == "AAPL"
    assert trade.quantity == 10.0
    assert trade.price > 0.0
    assert trade.total_amount == trade.quantity * trade.price

def test_consensus_buy_resolution():
    """Ensures ConsensusAgent accurately resolves to a BUY order under aligned signals."""
    buy = BuyAgent()
    sell = SellAgent()
    val = SellValidationAgent()
    thesis = ThesisAgent()
    
    node = ConsensusAgent(buy_agent=buy, sell_agent=sell, validator=val, thesis_agent=thesis)
    
    # Align signals to buy direction
    signals = [
        AgentSignal(agent_id="agent_quant_ml", symbol="AAPL", signal=OrderSide.BUY, confidence=0.82, reasoning="Breakout"),
        AgentSignal(agent_id="agent_news_sentiment", symbol="AAPL", signal=OrderSide.BUY, confidence=0.75, reasoning="Positive outlook")
    ]
    
    weights = {"agent_quant_ml": 0.40, "agent_news_sentiment": 0.40}
    
    decision, conf, reason = node.calculate_consensus(
        symbol="AAPL",
        signals=signals,
        agent_weights=weights,
        prices=[100.0, 101.0, 102.0],
        sector_trend="neutral",
        current_market_context={}
    )
    
    assert decision == OrderSide.BUY
    assert conf > 0.70
    assert "Recorded Thesis" in reason
