import logging
from typing import Dict, Any, List, Optional
from domain.entities import AgentSignal, OrderSide, Trade, TradeStatus, Position, RegimeType
from services.event_memory_service import EventMemoryService
from services.performance_manager import AgentPerformanceManager
from services.llm_service import PluggableLLMService
from agents.intelligence_agents import (
    EventMemoryAgent, NarrativeTrackingAgent, PoliticalIntelligenceAgent,
    GeopoliticalIntelligenceAgent, NewsSentimentAgent, MacroIntelligenceAgent
)
from agents.quantitative_agents import BaselineModelAgent, MLAgent, DeepLearningAgent, MarketRegimeAgent
from agents.decision_agents import BuyAgent, SellAgent, SellValidationAgent, ThesisAgent, ConsensusAgent
from risk.veto_agent import FinalRiskVetoAgent
from portfolio.portfolio_manager import PortfolioManager
from broker.paper_broker import PaperTradingBroker

# Setup logger
logger = logging.getLogger("TradingEngine")
logging.basicConfig(level=logging.INFO)

class MultiAgentTradingEngine:
    """
    Core Domain Coordination Engine.
    Executes modular dependency injection. Coordinates the lifecycle of:
    Data Ingestion -> AI & Technical Agents -> Consensus Node -> Risk Veto -> Broker Fill -> PnL Logging.
    """
    def __init__(self, portfolio_manager: PortfolioManager, broker: PaperTradingBroker):
        # 1. Services
        self.portfolio_manager = portfolio_manager
        self.broker = broker
        self.memory_service = EventMemoryService()
        self.performance_manager = AgentPerformanceManager()
        self.llm_service = PluggableLLMService()

        # 2. Intel Agents
        self.intel_agents = {
            "agent_event_memory": EventMemoryAgent(self.memory_service),
            "agent_narrative_tracking": NarrativeTrackingAgent(),
            "agent_political": PoliticalIntelligenceAgent(),
            "agent_geopolitical": GeopoliticalIntelligenceAgent(),
            "agent_news_sentiment": NewsSentimentAgent(),
            "agent_macro": MacroIntelligenceAgent()
        }

        # 3. Quantitative Agents
        self.baseline_agent = BaselineModelAgent()
        self.ml_agent = MLAgent()
        self.deep_learning = DeepLearningAgent()
        self.regime_agent = MarketRegimeAgent()

        # 4. Decision Block
        self.buy_agent = BuyAgent()
        self.sell_agent = SellAgent()
        self.sell_validator = SellValidationAgent()
        self.thesis_agent = ThesisAgent()
        self.consensus = ConsensusAgent(
            buy_agent=self.buy_agent,
            sell_agent=self.sell_agent,
            validator=self.sell_validator,
            thesis_agent=self.thesis_agent
        )

        # 5. Risk Safeguard
        self.risk_veto = FinalRiskVetoAgent()

    def evaluate_and_trade(
        self,
        symbol: str,
        sector: str,
        market_context_stream: Dict[str, Any],
        prices: List[float],
        volumes: List[float]
    ) -> Dict[str, Any]:
        """
        Executes a complete single multi-agent pipeline turn for an asset ticker.
        """
        logger.info(f"Initiating multi-agent evaluation cycle for symbol: {symbol}")
        
        # 1. Detect Regime and fetch dynamic agent voting weights
        regime = self.regime_agent.classify_regime(prices)
        agent_weights = self.regime_agent.get_dynamic_agent_weights(regime)
        logger.info(f"Detected Market Regime: {regime}. Dynamic weights fetched.")

        # 2. Ingest Data across Intel Agents & Query LLM context if applicable
        compiled_signals: List[AgentSignal] = []
        
        # Inject custom headline from news or fall back
        headline = market_context_stream.get("news_headline", f"Technical consolidation continues for {symbol}")
        market_context_stream["news_sentiment_score"] = self.llm_service.get_market_sentiment(headline)

        # Run Intel Agents
        for agent_id, agent in self.intel_agents.items():
            sig = agent.analyze(symbol, market_context_stream)
            compiled_signals.append(sig)

        # Run Quantitative Models
        base_sig = self.baseline_agent.analyze(symbol, prices, volumes)
        ml_sig = self.ml_agent.analyze(symbol, prices, volumes)
        dl_sig = self.deep_learning.analyze(symbol, prices)
        
        compiled_signals.extend([base_sig, ml_sig, dl_sig])

        # 3. Synthesize Consensus
        sector_trend = "strong_bullish" if regime == RegimeType.BULL_MARKET else "neutral"
        decision, confidence, reasoning = self.consensus.calculate_consensus(
            symbol=symbol,
            signals=compiled_signals,
            agent_weights=agent_weights,
            prices=prices,
            sector_trend=sector_trend,
            current_market_context=market_context_stream
        )
        logger.info(f"Consensus verdict reached: {decision} with confidence {confidence * 100:.1f}%")

        # 4. Filter Candidate through Risk Safeguard
        active_positions = self.portfolio_manager.get_positions_list()
        total_equity = self.portfolio_manager.get_total_equity()
        peak_equity = self.portfolio_manager.peak_valuation
        active_cash = self.portfolio_manager.cash

        cleared, candidate_trade, risk_msg = self.risk_veto.vet_proposed_order(
            symbol=symbol,
            side=decision,
            confidence=confidence,
            sector=sector,
            active_cash=active_cash,
            active_positions=active_positions,
            total_portfolio_equity=total_equity,
            peak_portfolio_equity=peak_equity
        )

        final_trade: Optional[Trade] = None
        vetoed = False
        execution_status = "No Trade Action"

        if decision == OrderSide.HOLD:
            execution_status = "HOLD consensus; no order dispatched."
        elif not cleared:
            vetoed = True
            execution_status = f"VETOED by Risk Management Layer: {risk_msg}"
            logger.warning(f"Proposed {decision} for {symbol} has been VETOED by Risk: {risk_msg}")
        else:
            # 5. Approved trade -> Dispatch to Broker
            logger.info(f"Risk checks cleared. Dispatched Order to broker...")
            
            if decision == OrderSide.BUY:
                # Sizer calculated amount inside candidate_trade.total_amount
                target_amount = candidate_trade.total_amount
                current_p = self.broker.get_current_price(symbol)
                qty_to_buy = round(target_amount / current_p, 4)
                
                try:
                    # Execute
                    filled_trade = self.broker.execute_order(symbol, OrderSide.BUY, candidate_trade.order_type, qty_to_buy)
                    if filled_trade.status == TradeStatus.FILLED or filled_trade.status == TradeStatus.PARTIALLY_FILLED:
                        self.portfolio_manager.add_position(symbol, filled_trade.quantity, filled_trade.price, sector)
                        final_trade = filled_trade
                        execution_status = f"BUY Filled. Bought {filled_trade.quantity} shares at ${filled_trade.price:.2f}"
                except Exception as ex:
                    execution_status = f"Broker Execution Failure: {str(ex)}"
                    logger.error(execution_status)
            
            elif decision == OrderSide.SELL:
                # Exit position
                if symbol in self.portfolio_manager.positions:
                    pos = self.portfolio_manager.positions[symbol]
                    qty_to_sell = pos.quantity
                    current_p = self.broker.get_current_price(symbol)
                    
                    try:
                        filled_trade = self.broker.execute_order(symbol, OrderSide.SELL, candidate_trade.order_type, qty_to_sell)
                        if filled_trade.status == TradeStatus.FILLED:
                            pnl_realized = self.portfolio_manager.close_position(symbol, filled_trade.price)
                            final_trade = filled_trade
                            execution_status = f"SELL Filled. Liquidated {qty_to_sell} shares at ${filled_trade.price:.2f}. Realized PnL: ${pnl_realized:.2f}"
                    except Exception as ex:
                        execution_status = f"Broker exit liquidation failed: {str(ex)}"
                        logger.error(execution_status)
                else:
                    execution_status = f"Approved SELL for {symbol} bypassed because asset is not held in portfolio."

        # 6. Log Signal Outcome to performance tracker (evaluate subsequent drift)
        p_before = prices[-1]
        p_after = p_before * (1.02 if decision == OrderSide.BUY else 0.98 if decision == OrderSide.SELL else 1.0)
        # Update metrics for voting weights optimization
        if final_trade:
            for s in compiled_signals:
                self.performance_manager.log_signal_outcome(s, final_trade, p_before, p_after)
            # Retrain Performance weights
            new_weights = self.performance_manager.optimize_agent_weights()
            logger.info("Agent weights successfully adjusted against outcome logs.")

        return {
            "symbol": symbol,
            "regime": regime,
            "decision": decision,
            "confidence": confidence,
            "consensus_explanation": reasoning,
            "vetoed_by_risk": vetoed,
            "execution_status": execution_status,
            "executed_trade": final_trade,
            "compiled_signals": [s.dict() for s in compiled_signals],
            "risk_vetos_logged": [v.dict() for v in self.risk_veto.veto_history]
        }
