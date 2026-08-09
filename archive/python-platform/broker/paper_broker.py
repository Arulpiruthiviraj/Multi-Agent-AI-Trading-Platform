import uuid
import random
from datetime import datetime
from typing import Optional, Dict
from domain.entities import Trade, TradeStatus, OrderSide, OrderType
from broker.base_broker import BaseBroker

class PaperTradingBroker(BaseBroker):
    """
    Paper Trading Broker Implementation.
    Acts as the default operational execution block.
    Supports partial fills, spread simulations, and fast transaction clearing.
    """
    def __init__(self, feed_source: Optional[Dict[str, float]] = None):
        self.connected = False
        # Inject standard price feed fallback values for assets (e.g. tech and metals)
        self.prices = {
            "AAPL": 178.50,
            "MSFT": 415.20,
            "NVDA": 875.12,
            "AMD": 160.40,
            "SPY": 510.30,
            "QQQ": 435.50,
            "GLD": 215.10,
            "TLT": 92.40
        }
        if feed_source:
            self.prices.update(feed_source)

    def connect(self) -> bool:
        self.connected = True
        return True

    def get_current_price(self, symbol: str) -> float:
        """Looks up symbol price with minor random walk variation to simulate ticker fluctuation."""
        base = self.prices.get(symbol, 100.0)
        fluctuation = random.uniform(-0.001, 0.001) * base
        current = max(1.0, base + fluctuation)
        self.prices[symbol] = current # Store updated drift
        return current

    def execute_order(self, symbol: str, side: OrderSide, order_type: OrderType, quantity: float, price_limit: Optional[float] = None) -> Trade:
        if not self.connected:
            raise ConnectionError("Broker connection inactive. Please call connect() first.")

        current_price = self.get_current_price(symbol)
        
        # Calculate execution parameters
        trade_price = current_price
        status = TradeStatus.FILLED
        filled_qty = quantity

        # If it is a Limit Order, verify trigger limits
        if order_type == OrderType.LIMIT and price_limit is not None:
            if side == OrderSide.BUY:
                if current_price <= price_limit:
                    trade_price = price_limit
                else:
                    # Simulate unfilled queue state
                    status = TradeStatus.PENDING
                    filled_qty = 0.0
            elif side == OrderSide.SELL:
                if current_price >= price_limit:
                    trade_price = price_limit
                else:
                    status = TradeStatus.PENDING
                    filled_qty = 0.0

        # Simulate rare Partial Fill occurrences (e.g. 5% probability) for large market quantities
        if status == TradeStatus.FILLED and quantity > 50 and random.random() < 0.05:
            status = TradeStatus.PARTIALLY_FILLED
            filled_qty = round(quantity * random.uniform(0.3, 0.7), 2)

        total_settlement = filled_qty * trade_price

        return Trade(
            id=f"tr_{uuid.uuid4().hex[:8]}",
            symbol=symbol,
            side=side,
            order_type=order_type,
            quantity=filled_qty,
            price=trade_price,
            total_amount=total_settlement,
            status=status,
            agent_id_source="broker_paper_match",
            thesis_summary=f"Simulated transaction cleared inside paper broker pipeline.",
            executed_at=datetime.utcnow() if status != TradeStatus.PENDING else None
        )

    def cancel_order(self, trade_id: str) -> bool:
        # Simulate successful clean transition cancellation
        return True
