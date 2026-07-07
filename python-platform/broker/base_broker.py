from abc import ABC, abstractmethod
from typing import List, Optional
from domain.entities import Trade, OrderSide, OrderType

class BaseBroker(ABC):
    """
    Abstract Broker Adapter.
    Swappable gateway for paper accounts or live institutional APIs (Alpaca, IB, Robinhood).
    """
    @abstractmethod
    def connect(self) -> bool:
        """Establishes session with exchange endpoints."""
        pass

    @abstractmethod
    def execute_order(self, symbol: str, side: OrderSide, order_type: OrderType, quantity: float, price_limit: Optional[float] = None) -> Trade:
        """Dispatches orders and handles response fills."""
        pass

    @abstractmethod
    def cancel_order(self, trade_id: str) -> bool:
        """Retracts an active, unfilled limit order."""
        pass

    @abstractmethod
    def get_current_price(self, symbol: str) -> float:
        """Queries asset real-time quotation values."""
        pass
