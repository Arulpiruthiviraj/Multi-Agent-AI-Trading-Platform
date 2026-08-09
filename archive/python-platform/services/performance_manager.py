from datetime import datetime
from typing import Dict, List, Any
import numpy as np
from domain.entities import AgentPerformance, AgentSignal, OrderSide, Trade, TradeStatus

class AgentPerformanceManager:
    """
    Performance Analyzer and Weight Governor.
    Monitors metrics across individual AI intelligence and technical agents, 
    dynamically shifting weighting profiles to enhance structural PnL yield.
    """
    def __init__(self):
        self.perf_db: Dict[str, AgentPerformance] = {}
        # Stores historic returns per agent to support Sharpe computations
        self._returns_history: Dict[str, List[float]] = {}
        
        # Initialize registry for all active agents
        self._register_agent("agent_event_memory", 1.0)
        self._register_agent("agent_narrative_tracking", 1.0)
        self._register_agent("agent_political", 1.0)
        self._register_agent("agent_geopolitical", 1.0)
        self._register_agent("agent_news_sentiment", 1.0)
        self._register_agent("agent_macro", 1.0)
        self._register_agent("agent_quant_baseline", 1.0)
        self._register_agent("agent_quant_ml", 1.0)

    def _register_agent(self, agent_id: str, init_weight: float):
        if agent_id not in self.perf_db:
            self.perf_db[agent_id] = AgentPerformance(
                agent_id=agent_id,
                current_weight=init_weight
            )
            self._returns_history[agent_id] = []

    def log_signal_outcome(self, signal: AgentSignal, trade_outcome: Trade, price_before: float, price_after: float):
        """
        Processes trade outcomes and updates individual agent accuracy, win/loss rates, average PnL.
        """
        agent_id = signal.agent_id
        self._register_agent(agent_id, 1.0)
        
        perf = self.perf_db[agent_id]
        perf.total_trades += 1
        
        # Was the signal directional logic correct?
        is_buy_success = (signal.signal == OrderSide.BUY) and (price_after > price_before)
        is_sell_success = (signal.signal == OrderSide.SELL) and (price_after < price_before)
        is_hold = signal.signal == OrderSide.HOLD
        
        pnl = 0.0
        if signal.signal == OrderSide.BUY:
            pnl = (price_after - price_before) / price_before
        elif signal.signal == OrderSide.SELL:
            pnl = (price_before - price_after) / price_before

        if not is_hold:
            self._returns_history[agent_id].append(pnl)
            
            if pnl > 0:
                perf.average_profit = ((perf.average_profit * (perf.total_trades - 1)) + pnl) / perf.total_trades
                # Increment accuracy bounds
                perf.total_trades += 0 # Keep tracking accurate
            else:
                perf.average_loss = ((perf.average_loss * (perf.total_trades - 1)) + abs(pnl)) / perf.total_trades

            # Recalculate accuracies and wins
            correct_trades = sum(1 for r in self._returns_history[agent_id] if r > 0)
            perf.win_rate = correct_trades / len(self._returns_history[agent_id])
            perf.loss_rate = 1.0 - perf.win_rate
            perf.accuracy = perf.win_rate
            
            # Recalculate Sharpe Ratio proxy (mean return / std deviation of returns)
            returns = np.array(self._returns_history[agent_id])
            if len(returns) >= 3:
                r_mean = np.mean(returns)
                r_std = np.std(returns)
                perf.sharpe_ratio = float(r_mean / (r_std + 0.0001) * np.sqrt(252)) # Standardized Annualized Ratio
            else:
                perf.sharpe_ratio = 1.2 # Baseline seed
                
            # Simulate historical drawdown trackers
            if pnl < 0:
                drawdown_candidate = abs(pnl)
                if drawdown_candidate > perf.max_drawdown:
                    perf.max_drawdown = drawdown_candidate
                    
        perf.updated_at = datetime.utcnow()

    def optimize_agent_weights(self) -> Dict[str, float]:
        """
        Calculates agent weights based on their relative Win Rates and Sharpe Ratios.
        Forces high-performing agents to have higher casting weights.
        """
        weights: Dict[str, float] = {}
        total_score = 0.0
        
        # Calculate scores
        for agent_id, perf in self.perf_db.items():
            sharpe_factor = max(0.1, perf.sharpe_ratio)
            win_factor = max(0.3, perf.accuracy)
            
            # Formulate composite scoring value
            score = win_factor * 0.6 + (sharpe_factor / 3.0) * 0.4
            weights[agent_id] = score
            total_score += score
            
        # Normalize weights
        for agent_id in weights:
            normalized_weight = weights[agent_id] / (total_score + 0.0001)
            # Clip between min 0.05 and max 0.45 safety constraints
            final_w = max(0.05, min(0.45, normalized_weight))
            self.perf_db[agent_id].current_weight = final_w
            weights[agent_id] = final_w
            
        return weights

    def get_agent_metrics(self, agent_id: str) -> Optional[AgentPerformance]:
        return self.perf_db.get(agent_id)
