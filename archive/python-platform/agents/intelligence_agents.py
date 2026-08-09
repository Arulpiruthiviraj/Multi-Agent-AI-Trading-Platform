from abc import ABC, abstractmethod
from datetime import datetime
from typing import Dict, Any, List
from domain.entities import AgentSignal, OrderSide, NarrativeTrend, Narrative
from services.event_memory_service import EventMemoryService

class BaseIntelligenceAgent(ABC):
    """
    Abstract Base Class representing a pluggable AI intelligence agent.
    Each agent focuses on an independent information stream.
    """
    def __init__(self, agent_id: str):
        self.agent_id = agent_id

    @abstractmethod
    def analyze(self, symbol: str, data_context: Dict[str, Any]) -> AgentSignal:
        """
        Executes domain analysis and outputs a typed market signal.
        """
        pass

class EventMemoryAgent(BaseIntelligenceAgent):
    """
    Agent 1: Event Memory Agent. Looks up historical precedents to evaluate current reactions.
    """
    def __init__(self, memory_service: EventMemoryService):
        super().__init__("agent_event_memory")
        self.memory_service = memory_service

    def analyze(self, symbol: str, data_context: Dict[str, Any]) -> AgentSignal:
        situation = data_context.get("macro_news_headline", f"Tensions rise over tariff rates affecting {symbol}")
        context_string = self.memory_service.generate_event_context(situation)
        
        # Analyze similarities to infer direction
        if "pandemic" in context_string.lower() or "crisis" in context_string.lower():
            signal = OrderSide.HOLD
            confidence = 0.65
            reasoning = "Historical precedents indicate panic leading to immediate liquidity crunch. Outlining a defensive bias."
        elif "tariff" in context_string.lower() or "trade war" in context_string.lower():
            signal = OrderSide.SELL
            confidence = 0.72
            reasoning = " tariffs typically trigger sector-specific margin contraction in technology and semiconductor items. Sells or shorting recommended."
        else:
            signal = OrderSide.BUY
            confidence = 0.55
            reasoning = "Baseline historical reversion suggests positive outcome following macro shocks."

        return AgentSignal(
            agent_id=self.agent_id,
            symbol=symbol,
            signal=signal,
            confidence=confidence,
            reasoning=f"Precendent Match: {context_string[:150]}... Verdict: {reasoning}",
            metadata={"source_precedents": ["2018 Trade War", "1970 OPEC"]}
        )

class NarrativeTrackingAgent(BaseIntelligenceAgent):
    """
    Agent 2: Narrative Tracking Agent. Measures strength of thematic investment narratives.
    """
    def __init__(self):
        super().__init__("agent_narrative_tracking")
        self._monitored_narratives = [
            Narrative(id="nar_1", name="Artificial Intelligence", trend=NarrativeTrend.STRENGTHENING, sentiment_score=0.85, source_count=214),
            Narrative(id="nar_2", name="Defense Spending", trend=NarrativeTrend.STRENGTHENING, sentiment_score=0.74, source_count=89),
            Narrative(id="nar_3", name="Manufacturing Reshoring", trend=NarrativeTrend.EMERGING, sentiment_score=0.45, source_count=34),
            Narrative(id="nar_4", name="Rate Cuts", trend=NarrativeTrend.WEAKENING, sentiment_score=-0.20, source_count=120)
        ]

    def analyze(self, symbol: str, data_context: Dict[str, Any]) -> AgentSignal:
        sector = data_context.get("sector", "Technology").lower()
        
        # Match narrative to company sector
        matched_narratives = []
        for n in self._monitored_narratives:
            if "technology" in sector and n.name in ["Artificial Intelligence", "Semiconductors"]:
                matched_narratives.append(n)
            elif "industrial" in sector and n.name in ["Manufacturing Reshoring", "Defense Spending"]:
                matched_narratives.append(n)

        if matched_narratives:
            best_narrative = max(matched_narratives, key=lambda x: x.sentiment_score)
            if best_narrative.trend == NarrativeTrend.STRENGTHENING and best_narrative.sentiment_score > 0.5:
                return AgentSignal(
                    agent_id=self.agent_id,
                    symbol=symbol,
                    signal=OrderSide.BUY,
                    confidence=0.82,
                    reasoning=f"Strong macro tailwind from the strengthening '{best_narrative.name}' narrative (Sentiment: {best_narrative.sentiment_score}).",
                    metadata={"related_narratives": [n.name for n in matched_narratives]}
                )
        
        return AgentSignal(
            agent_id=self.agent_id,
            symbol=symbol,
            signal=OrderSide.HOLD,
            confidence=0.50,
            reasoning="Neutral narrative indicators. Sector does not align with any strengthening thematic drivers.",
            metadata={}
        )

class PoliticalIntelligenceAgent(BaseIntelligenceAgent):
    """
    Agent 3: Political Intelligence Agent. Assesses presidential statements, tariffs, major legislation.
    """
    def __init__(self):
        super().__init__("agent_political")

    def analyze(self, symbol: str, data_context: Dict[str, Any]) -> AgentSignal:
        tariffs_pending = data_context.get("political_tariffs_announced", False)
        regulatory_scrutiny = data_context.get("regulatory_oversight_level", "low")
        
        if tariffs_pending:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.SELL,
                confidence=0.78,
                reasoning="Vulnerable import exposure. Anticipated tariff policies are highly bearish for supply-chain margins.",
                metadata={"tariff_threat_index": "High"}
            )
        elif regulatory_scrutiny == "high":
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.HOLD,
                confidence=0.60,
                reasoning="Congressional antitrust activity or anti-monopoly hearings create headline ceiling risk.",
                metadata={"regulatory_status": "Oversight Escalating"}
            )
            
        return AgentSignal(
            agent_id=self.agent_id,
            symbol=symbol,
            signal=OrderSide.BUY,
            confidence=0.58,
            reasoning="Constructive geopolitical legislative spending bills (e.g. clean infrastructure subsidies) serve as structural support.",
            metadata={"legislation": "Infrastructure Package Support"}
        )

class GeopoliticalIntelligenceAgent(BaseIntelligenceAgent):
    """
    Agent 4: Geopolitical Intelligence Agent. Monitors international trade disputes, conflicts, blockades.
    """
    def __init__(self):
        super().__init__("agent_geopolitical")

    def analyze(self, symbol: str, data_context: Dict[str, Any]) -> AgentSignal:
        conflict_status = data_context.get("geopolitical_risk_index", 0.2) # Scale of 0.0 to 1.0
        
        if conflict_status > 0.7:
            # High instability suggests flights to hard safety assets
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.SELL,
                confidence=0.80,
                reasoning="High conflict index. Multi-lateral trade blockades threaten global logistics channels. Standard risk-off posture.",
                metadata={"conflict_index": conflict_status}
            )
        elif conflict_status < 0.3:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.BUY,
                confidence=0.60,
                reasoning="Calm geopolitical premium. Global trade agreements progressing smoothly without friction.",
                metadata={"conflict_index": conflict_status}
            )
            
        return AgentSignal(
            agent_id=self.agent_id,
            symbol=symbol,
            signal=OrderSide.HOLD,
            confidence=0.50,
            reasoning="Moderate geopolitical indicators. Regional situations contained, neutral impact predicted.",
            metadata={}
        )

class NewsSentimentAgent(BaseIntelligenceAgent):
    """
    Agent 5: News Sentiment Agent. Aggregates media headline sentiment ratios.
    """
    def __init__(self):
        super().__init__("agent_news_sentiment")

    def analyze(self, symbol: str, data_context: Dict[str, Any]) -> AgentSignal:
        sentiment = data_context.get("news_sentiment_score", 0.0) # -1.0 Bearish to 1.0 Bullish
        news_volume = data_context.get("news_article_volume", 50)
        
        if sentiment > 0.4:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.BUY,
                confidence=min(0.90, 0.5 + sentiment * 0.4),
                reasoning=f"Extremely bullish public news sentiment. Volume index high ({news_volume} major publications) indicating buy pressure.",
                metadata={"sentiment_score": sentiment, "volume": news_volume}
            )
        elif sentiment < -0.4:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.SELL,
                confidence=min(0.90, 0.5 + abs(sentiment) * 0.4),
                reasoning="Preponderance of media headlines highlight regulatory inquiries, production delays, or litigation risks.",
                metadata={"sentiment_score": sentiment, "volume": news_volume}
            )

        return AgentSignal(
            agent_id=self.agent_id,
            symbol=symbol,
            signal=OrderSide.HOLD,
            confidence=0.55,
            reasoning="Balanced or quiet headline channels, no active sentiment drift identified.",
            metadata={"sentiment_score": sentiment}
        )

class MacroIntelligenceAgent(BaseIntelligenceAgent):
    """
    Agent 6: Macro Intelligence Agent. Evaluates GDP growth, inflation (CPI), Fed yields, and interest rates.
    """
    def __init__(self):
        super().__init__("agent_macro")

    def analyze(self, symbol: str, data_context: Dict[str, Any]) -> AgentSignal:
        interest_rate = data_context.get("macro_interest_rate", 5.25) # Fed rate %
        inflation_rate = data_context.get("macro_inflation_cpi", 3.1) # CPI YoY %
        
        # Sells/defensive assets if interest rate or inflation triggers high financing friction
        if interest_rate > 5.5 and inflation_rate > 4.0:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.SELL,
                confidence=0.75,
                reasoning=f"Bearish macro combination: High rates ({interest_rate}%) coupled with sticky inflation ({inflation_rate}%) increases cost of capital.",
                metadata={"rate_friction": "Severe"}
            )
        elif interest_rate < 3.0:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.BUY,
                confidence=0.70,
                reasoning="Easy-money conditions. Highly stimulative low-rate cycles foster multiples expansion across growth names.",
                metadata={"rate_friction": "Accommodative"}
            )
            
        return AgentSignal(
            agent_id=self.agent_id,
            symbol=symbol,
            signal=OrderSide.HOLD,
            confidence=0.58,
            reasoning="Macro indices stabilized within Fed targets. Stable interest environment encourages stock-specific valuation focus.",
            metadata={"interest_rate": interest_rate, "inflation": inflation_rate}
        )
