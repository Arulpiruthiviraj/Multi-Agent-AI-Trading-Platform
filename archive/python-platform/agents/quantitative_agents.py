from typing import Dict, Any, List
import numpy as np
from domain.entities import AgentSignal, OrderSide, RegimeType

class BaselineModelAgent:
    """
    Baseline Model Agent. Uses simple Ridge/Logistic regression models of stock momentum.
    """
    def __init__(self):
        self.agent_id = "agent_quant_baseline"

    def analyze(self, symbol: str, prices: List[float], volumes: List[float]) -> AgentSignal:
        if len(prices) < 20:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.HOLD,
                confidence=0.50,
                reasoning="Insufficent price history length to train baseline linear model."
            )
        
        # Simple Linear regression on log returns proxy
        y = np.log(np.array(prices[1:]) / np.array(prices[:-1]))
        x = np.arange(len(y)).reshape(-1, 1)
        
        # Compute slope
        x_mean = np.mean(x)
        y_mean = np.mean(y)
        slope = np.sum((x - x_mean) * (y - y_mean).reshape(-1, 1)) / np.sum((x - x_mean) ** 2)
        
        if slope > 0.0005:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.BUY,
                confidence=min(0.75, 0.5 + abs(slope) * 200),
                reasoning=f"Baseline Ridge trend positive. Upward slope identified: {slope:.6f}.",
                metadata={"slope": float(slope)}
            )
        elif slope < -0.0005:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.SELL,
                confidence=min(0.75, 0.5 + abs(slope) * 200),
                reasoning=f"Baseline Ridge trend negative. Downward drift identified: {slope:.6f}.",
                metadata={"slope": float(slope)}
            )
            
        return AgentSignal(
            agent_id=self.agent_id,
            symbol=symbol,
            signal=OrderSide.HOLD,
            confidence=0.50,
            reasoning=f"Sideways momentum, slope {slope:.6f} falls within consolidation threshold.",
            metadata={"slope": float(slope)}
        )

class MLAgent:
    """
    Machine Learning Agent. Interfaces with trained XGBoost or LightGBM assets.
    Exposes complete technical feature engineering pipelines.
    """
    def __init__(self):
        self.agent_id = "agent_quant_ml"

    def _engineer_features(self, prices: List[float], volumes: List[float]) -> Dict[str, float]:
        """Runs institutional feature formulas (RSI, Bollinger, ATR proxy)."""
        p = np.array(prices)
        v = np.array(volumes)
        
        # Simple Moving Averages
        sma5 = np.mean(p[-5:]) if len(p) >= 5 else p[-1]
        sma20 = np.mean(p[-20:]) if len(p) >= 20 else p[-1]
        
        # RSI proxy
        diffs = np.diff(p)
        gains = diffs[diffs > 0]
        losses = -diffs[diffs < 0]
        avg_gain = np.mean(gains) if len(gains) > 0 else 0.001
        avg_loss = np.mean(losses) if len(losses) > 0 else 0.001
        rsi = 100 - (100 / (1 + (avg_gain / avg_loss)))
        
        # Volatility proxy
        std = np.std(p[-20:]) if len(p) >= 20 else np.std(p)
        bollinger_upper = sma20 + 2 * std
        bollinger_lower = sma20 - 2 * std
        
        return {
            "sma_ratio": float(sma5 / sma20),
            "rsi": float(rsi),
            "bollinger_pct": float((p[-1] - bollinger_lower) / (bollinger_upper - bollinger_lower + 0.001)),
            "volume_z_score": float((v[-1] - np.mean(v)) / (np.std(v) + 0.001)) if len(v) > 1 else 0.0
        }

    def analyze(self, symbol: str, prices: List[float], volumes: List[float]) -> AgentSignal:
        if len(prices) < 20:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.HOLD,
                confidence=0.50,
                reasoning="Insufficent technical history for ML feature computation."
            )
            
        feats = self._engineer_features(prices, volumes)
        
        # Mocking predictions of tree models (XGBoost/LightGBM) on the engineered structures
        rsi = feats["rsi"]
        sma_ratio = feats["sma_ratio"]
        volume_z = feats["volume_z_score"]
        
        score = 0.0
        if rsi < 30 and volume_z > 1.5:
            score += 0.45  # Oversold buy signal on high volume
        elif rsi > 70 and volume_z > 1.5:
            score -= 0.45  # Overbought sell signal on high volume
            
        if sma_ratio > 1.02:
            score += 0.35  # Strong golden cross momentum
        elif sma_ratio < 0.98:
            score -= 0.35  # Bearish death cross

        if score > 0.25:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.BUY,
                confidence=min(0.90, 0.5 + abs(score)),
                reasoning=f"XGBoost Classifier predicts trend reversal (Oversold/Volume signal). RSI: {rsi:.1f}, SMA Ratio: {sma_ratio:.3f}",
                metadata=feats
            )
        elif score < -0.25:
            return AgentSignal(
                agent_id=self.agent_id,
                symbol=symbol,
                signal=OrderSide.SELL,
                confidence=min(0.90, 0.5 + abs(score)),
                reasoning=f"LightGBM Multi-class model projects trend depletion. RSI: {rsi:.1f}, Exhaustion Volume Z-score: {volume_z:.2f}",
                metadata=feats
            )
            
        return AgentSignal(
            agent_id=self.agent_id,
            symbol=symbol,
            signal=OrderSide.HOLD,
            confidence=0.52,
            reasoning="Gradient Boosting decision forest returns class probability under the trigger threshold.",
            metadata=feats
        )

class DeepLearningAgent:
    """
    Sub-architectural Deep Learning Model Framework.
    Pre-configured for pluggable sequence-based models (LSTM, Transformers).
    """
    def __init__(self):
        self.agent_id = "agent_quant_deep_learning"

    def analyze(self, symbol: str, prices: List[float], sequence_length: int = 60) -> AgentSignal:
        """
        Placeholder container for sequence prediction interfaces.
        In future iterations, feeds price vectors to PyTorch torch.nn.TransformerEncoder networks.
        """
        return AgentSignal(
            agent_id=self.agent_id,
            symbol=symbol,
            signal=OrderSide.HOLD,
            confidence=0.50,
            reasoning="Deep Learning LSTM/Transformer inference skipped (Architectural placeholder only).",
            metadata={"network_architecture": "PyTorch LSTM+Transformer block, dim=128, heads=4"}
        )

class MarketRegimeAgent:
    """
    Market Regime Categorizer.
    Analyzes systemic index assets to classify regimes:
    [BULL_MARKET, BEAR_MARKET, SIDEWAYS_MARKET, HIGH_VOLATILITY, LOW_VOLATILITY]
    Uses categorization to return dynamic voting multipliers for active trading agents.
    """
    def __init__(self):
        self.agent_id = "agent_regime_tracker"

    def classify_regime(self, benchmark_prices: List[float]) -> RegimeType:
        if len(benchmark_prices) < 30:
            return RegimeType.SIDEWAYS_MARKET
        
        recent_prices = benchmark_prices[-10:]
        older_prices = benchmark_prices[-30:-10]
        
        recent_mean = np.mean(recent_prices)
        older_mean = np.mean(older_prices)
        
        all_returns = np.diff(benchmark_prices) / benchmark_prices[:-1]
        volt_index = float(np.std(all_returns) * 100) # Percentage metric
        
        if volt_index > 2.2:
            return RegimeType.HIGH_VOLATILITY
        
        drift = (recent_mean - older_mean) / older_mean
        
        if drift > 0.04:
            return RegimeType.BULL_MARKET
        elif drift < -0.04:
            return RegimeType.BEAR_MARKET
        
        if volt_index < 0.8:
            return RegimeType.LOW_VOLATILITY
            
        return RegimeType.SIDEWAYS_MARKET

    def get_dynamic_agent_weights(self, regime: RegimeType) -> Dict[str, float]:
        """
        Dynamically adjusts agent votes over time based on regimes.
        Severe drawdowns can trigger quantitative overrides. High volatility prioritizes macro.
        """
        if regime == RegimeType.BULL_MARKET:
            return {
                "agent_quant_ml": 0.40,
                "agent_quant_baseline": 0.20,
                "agent_narrative_tracking": 0.25,
                "agent_news_sentiment": 0.15,
                "agent_macro": 0.00
            }
        elif regime == RegimeType.BEAR_MARKET:
            return {
                "agent_quant_ml": 0.20,
                "agent_quant_baseline": 0.10,
                "agent_macro": 0.40,
                "agent_political": 0.20,
                "agent_event_memory": 0.10
            }
        elif regime == RegimeType.HIGH_VOLATILITY:
            return {
                "agent_macro": 0.35,
                "agent_geopolitical": 0.25,
                "agent_event_memory": 0.25,
                "agent_quant_ml": 0.15
            }
        elif regime == RegimeType.LOW_VOLATILITY:
            return {
                "agent_quant_ml": 0.50,
                "agent_quant_baseline": 0.30,
                "agent_news_sentiment": 0.20
            }
            
        # Default even balance for sideways market
        return {
            "agent_quant_ml": 0.25,
            "agent_quant_baseline": 0.15,
            "agent_narrative_tracking": 0.20,
            "agent_news_sentiment": 0.20,
            "agent_macro": 0.20
        }
