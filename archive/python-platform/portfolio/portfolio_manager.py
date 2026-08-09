from typing import Dict, List, Optional
from datetime import datetime
from domain.entities import Position, PortfolioSnapshot

class PortfolioManager:
    """
    Sub-system coordinator tracking active positions, cash buffers,
    unrealized profit/loss indices and overall risk health scores.
    """
    def __init__(self, initial_cash: float = 100000.0):
        self.cash = initial_cash
        self.positions: Dict[str, Position] = {}
        self.peak_valuation: float = initial_cash
        self.initial_cash = initial_cash

    def get_positions_list(self) -> List[Position]:
        return list(self.positions.values())

    def update_position_price(self, symbol: str, current_price: float):
        """Re-evaluates asset value, updating unrealized PnL fields."""
        if symbol in self.positions:
            pos = self.positions[symbol]
            pos.current_price = current_price
            pos.market_value = pos.quantity * current_price
            pos.unrealized_pnl = pos.market_value - pos.total_cost
            pos.unrealized_pnl_percent = pos.unrealized_pnl / (pos.total_cost + 0.001)
            pos.updated_at = datetime.utcnow()

    def add_position(self, symbol: str, quantity: float, price: float, sector: str):
        """Creates or adds shares to a live holding."""
        cost = quantity * price
        if self.cash < cost:
            raise ValueError(f"Insufficient cash structure to complete trade. Cost: {cost}, Cash: {self.cash}")
            
        self.cash -= cost
        
        if symbol in self.positions:
            pos = self.positions[symbol]
            new_qty = pos.quantity + quantity
            new_cost = pos.total_cost + cost
            pos.entry_price = new_cost / new_qty
            pos.quantity = new_qty
            pos.total_cost = new_cost
            pos.updated_at = datetime.utcnow()
        else:
            self.positions[symbol] = Position(
                symbol=symbol,
                quantity=quantity,
                entry_price=price,
                current_price=price,
                total_cost=cost,
                market_value=cost,
                unrealized_pnl=0.0,
                unrealized_pnl_percent=0.0,
                sector=sector
            )
        self.update_position_price(symbol, price)

    def close_position(self, symbol: str, price: float) -> float:
        """Fully liquidates a position and returns the cash proceeds."""
        if symbol not in self.positions:
            return 0.0
            
        pos = self.positions[symbol]
        revenue = pos.quantity * price
        self.cash += revenue
        realized_pnl = revenue - pos.total_cost
        del self.positions[symbol]
        return realized_pnl

    def get_total_equity(self) -> float:
        positions_value = sum(pos.market_value for pos in self.positions.values())
        return self.cash + positions_value

    def generate_snapshot(self) -> PortfolioSnapshot:
        total = self.get_total_equity()
        if total > self.peak_valuation:
            self.peak_valuation = total
            
        pos_val = sum(p.market_value for p in self.positions.values())
        unrealized = sum(p.unrealized_pnl for p in self.positions.values())
        
        # Calculate drawdown Pct
        drawdown_pct = 0.0
        if self.peak_valuation > 0:
            drawdown_pct = (self.peak_valuation - total) / self.peak_valuation
            
        # Compile an academic health score out of 100
        # Penalizes high drawdown, over-leverage, and lack of diversification
        base_score = 100.0
        base_score -= (drawdown_pct * 300.0) # -30 points for every 10% drawdown
        
        # Diversification penalty: check if any sector exceeds 35%
        sector_totals: Dict[str, float] = {}
        for p in self.positions.values():
            sector_totals[p.sector] = sector_totals.get(p.sector, 0.0) + p.market_value
            
        for sect, s_val in sector_totals.items():
            sect_pct = s_val / (total + 0.001)
            if sect_pct > 0.35:
                base_score -= 15.0 # -15 penalty for concentration
                
        # Reserve buffer penalty: warn if cash drops below 5% of total equity
        if self.cash < (total * 0.05):
            base_score -= 10.0

        health = max(0.0, min(100.0, base_score))
        
        return PortfolioSnapshot(
            id=f"snap_{datetime.utcnow().strftime('%Y%m%d%H%M')}",
            total_equity=total,
            cash_balance=self.cash,
            positions_value=pos_val,
            unrealized_pnl=unrealized,
            daily_drawn_percent=drawdown_pct,
            health_score=health
        )
