import uuid
from typing import List, Dict, Any
from datetime import datetime
from domain.entities import AgentSignal, OrderSide, Trade, TradeStatus

class BuyAgent:
    """
    Buy Agent. Identifies specific entry conditions from quantitative momentum indicators 
    and strong thematic/narrative intelligence signals.
    """
    def __init__(self):
        self.agent_id = "agent_buy_strategist"

    def aggregate_buy_conviction(self, signals: List[AgentSignal]) -> tuple[bool, float, str]:
        """
        Analyzes signals to determine if a buy condition is triggered and at what confidence.
        """
        buy_signals = [s for s in signals if s.signal == OrderSide.BUY]
        if not buy_signals:
            return False, 0.0, "No active buy indicators found."
        
        # Calculate weighted average confidence of buy signals
        total_conf = sum(s.confidence for s in buy_signals)
        avg_conf = total_conf / len(buy_signals)
        
        # If we have positive structural alignment across multiple agents
        if len(buy_signals) >= 2 and avg_conf > 0.60:
            return True, avg_conf, f"Buy triggered via high-confidence consensus from {len(buy_signals)} intelligence streams."
            
        # Single high confidence signal
        if len(buy_signals) == 1 and buy_signals[0].confidence >= 0.75:
            return True, buy_signals[0].confidence, f"High conviction standalone buy signals from {buy_signals[0].agent_id}."
            
        return False, avg_conf, "Momentum indicators present but insufficient to meet structural entry thresholds."

class SellAgent:
    """
    Sell Agent. Identifies structural exit flags or technical trend failure triggers.
    """
    def __init__(self):
        self.agent_id = "agent_sell_strategist"

    def aggregate_sell_conviction(self, signals: List[AgentSignal], position_age_days: int = 0) -> tuple[bool, float, str]:
        sell_signals = [s for s in signals if s.signal == OrderSide.SELL]
        if not sell_signals:
            return False, 0.0, "No active sell/liquidation triggers detected."
            
        avg_conf = sum(s.confidence for s in sell_signals) / len(sell_signals)
        
        # Sells are prioritized defensively (requires lower count with lower confidence to trigger)
        if len(sell_signals) >= 1 and avg_conf >= 0.55:
            return True, avg_conf, f"Sells triggered due to defensive exit matching from {sell_signals[0].agent_id}."
            
        return False, avg_conf, "Consensus exit threshold not reached."

class SellValidationAgent:
    """
    Sell Validation Agent.
    Specialized diagnostic block distinguishing between standard, temporary pullbacks 
    and actual systemic narrative / technical failures.
    """
    def __init__(self):
        self.agent_id = "agent_sell_validator"

    def validate_sell_signal(self, sell_reason: str, prices: List[float], sector_status: str) -> tuple[bool, str]:
        """
        Returns True if the sell is a VALID exit, and False if it is classified as a
        temporary pullback buy-opportunity.
        """
        if len(prices) < 5:
            return True, "Insufficient price context. Defaulting to defensive sell execution."
            
        # Is the asset in a high-volatility short-term consolidation but positive longer-term?
        recent_change = (prices[-1] - prices[-5]) / prices[-5]
        
        # If it's a minor pullback less than 3% down, and the sector is highly bullish
        if recent_change > -0.03 and recent_change < 0.0 and "strong" in sector_status.lower():
            return False, "Vetoed Sell: Market dip classified as typical short-term consolidation pullback rather than asset value impairment. Recommend HOLD/BUY."
            
        return True, f"Sell confirmed. Price action and sector trend validation match structural breakdown profile (recent movement: {recent_change*100:.2f}%)."

class ThesisAgent:
    """
    Thesis Agent.
    Records, archives, and continuously validates active reasons for entering a position.
    Re-validates the initial buy thesis prior to allowing exit operations.
    """
    def __init__(self):
        self.agent_id = "agent_thesis_archiver"
        self._theses_db: Dict[str, Dict[str, Any]] = {}

    def record_thesis(self, symbol: str, signals: List[AgentSignal], current_price: float) -> str:
        key_reasons = [f"{s.agent_id}: {s.reasoning}" for s in signals if s.signal == OrderSide.BUY]
        thesis_summary = f"Bought at ${current_price:.2f} based on: " + " | ".join(key_reasons[:3])
        
        self._theses_db[symbol] = {
            "thesis": thesis_summary,
            "recorded_at": datetime.utcnow(),
            "entry_price": current_price,
            "signals": [s.dict() for s in signals]
        }
        return thesis_summary

    def get_thesis(self, symbol: str) -> Optional[str]:
        data = self._theses_db.get(symbol)
        return data["thesis"] if data else None

    def revalidate_thesis(self, symbol: str, current_market_context: Dict[str, Any]) -> tuple[bool, str]:
        """
        Compares original entry thesis against current conditions to determine if the core 
        investment narrative is broken or still intact.
        """
        thesis = self.get_thesis(symbol)
        if not thesis:
            return False, "No active historical thesis on record for this position."
            
        # If the thesis was driven by interest rates cooling and rates are rising again
        if "rate" in thesis.lower() and current_market_context.get("rates_rebounding", False):
            return False, "Thesis Broken: Rates rebounding directly invalidates original monetary easing assumptions."
            
        return True, "Core structural thesis remains valid."

class ConsensusAgent:
    """
    Consensus Agent.
    Aggregates inputs from all layered quantitative and intelligence agents,
    applying dynamic weighted voting rules to compile a final BUY/SELL/HOLD recommendation.
    """
    def __init__(self, buy_agent: BuyAgent, sell_agent: SellAgent, validator: SellValidationAgent, thesis_agent: ThesisAgent):
        self.agent_id = "agent_consensus_node"
        self.buy_agent = buy_agent
        self.sell_agent = sell_agent
        self.validator = validator
        self.thesis_agent = thesis_agent

    def calculate_consensus(
        self,
        symbol: str,
        signals: List[AgentSignal],
        agent_weights: Dict[str, float],
        prices: List[float],
        sector_trend: str,
        current_market_context: Dict[str, Any]
    ) -> tuple[OrderSide, float, str]:
        """
        Compiles all signals together to produce the final recommendation.
        Returns (recommendation, confidence, detailed_explanation)
        """
        if not signals:
            return OrderSide.HOLD, 0.50, "No inputs from source agents."

        # Compute weighted voting score
        # BUY = +1, SELL = -1, HOLD = 0
        total_weight = 0.0
        weighted_score = 0.0
        
        for s in signals:
            weight = agent_weights.get(s.agent_id, 0.1)
            total_weight += weight
            
            if s.signal == OrderSide.BUY:
                weighted_score += weight * s.confidence
            elif s.signal == OrderSide.SELL:
                weighted_score -= weight * s.confidence

        normalized_score = weighted_score / (total_weight + 0.0001)

        # 1. Evaluate Sell Logic
        if normalized_score < -0.15:
            is_sell_triggered, sell_conf, sell_desc = self.sell_agent.aggregate_sell_conviction(signals)
            if is_sell_triggered:
                # Intercept with Validation Agent
                is_valid, validation_msg = self.validator.validate_sell_signal(sell_desc, prices, sector_trend)
                if not is_valid:
                    return OrderSide.HOLD, 0.60, f"Modified: {validation_msg} (Sell suppressed)"
                    
                # Thesis re-validation check
                thesis_intact, thesis_msg = self.thesis_agent.revalidate_thesis(symbol, current_market_context)
                explanation = f"Consensus SELL (score: {normalized_score:.2f}). Reason: {sell_desc}. Thesis Status: {thesis_msg}"
                return OrderSide.SELL, max(0.5, abs(normalized_score)), explanation

        # 2. Evaluate Buy Logic
        if normalized_score > 0.15:
            is_buy_triggered, buy_conf, buy_desc = self.buy_agent.aggregate_buy_conviction(signals)
            if is_buy_triggered:
                # Record initial thesis
                recorded = self.thesis_agent.record_thesis(symbol, signals, prices[-1] if prices else 100.0)
                explanation = f"Consensus BUY (score: {normalized_score:.2f}). Decision: {buy_desc}. Recorded Thesis: {recorded}."
                return OrderSide.BUY, buy_conf, explanation

        return OrderSide.HOLD, 0.50, f"Consensus Neutral (score: {normalized_score:.2f}). Signals fall short of entry/exit hurdles."
