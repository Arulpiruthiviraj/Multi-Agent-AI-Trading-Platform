/**
 * TradingAgents shadow/research interface - SCAFFOLD ONLY.
 *
 * ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md Phase 11. There is no
 * TradingAgents integration code anywhere in this repository. This file defines the shape a
 * future, explicitly-authorized adapter would implement, and ships exactly one implementation:
 * NullTradingAgentsShadowAdapter, which always returns null. Nothing in the live codebase
 * constructs or calls anything in this file - it is not wired into ChiefTraderAgent, RiskEngine,
 * QuantSignalAgent, EventBus, or any other live path. It exists so the eventual shape is
 * documented and typed, not so the capability exists.
 *
 * Non-negotiable contract for any real future implementation:
 * - MUST NOT call BrokerManager, OrderManagementService, or any placeOrder path.
 * - MUST NOT bypass ChiefTraderAgent consensus or RiskEngine's 24 gates.
 * - MUST NOT write to agent_performance_stats.currentWeight or any other live-weight field.
 * - MUST label every opinion it produces as shadow/research (never presented as a live vote).
 * - MUST fail closed (return null / "unavailable") on any error, timeout, or malformed output -
 *   never fabricate an opinion.
 */
import { isTradingAgentsShadowEnabled } from '../config/tradingSafety';

export interface ArgusMarketSnapshot {
  symbol: string;
  timestampMs: number;
  currentPrice: number;
  /** Compact "REGIME/VOLATILITY" string (lightweightRegimeClassifier.ts's encodeRegime), if known. */
  regime?: string;
}

export interface ShadowOpinion {
  symbol: string;
  direction: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0-1, same scale every other TRADE_IDEA_GENERATED emitter uses
  thesis: string;
  timestampMs: number;
  /** Always this literal - never mistakable for a real agent's vote in any downstream consumer. */
  source: 'TRADING_AGENTS_SHADOW';
}

export interface TradingAgentsShadowAdapter {
  /** Returns null on any failure, timeout, or when the adapter is disabled - never fabricates an opinion. */
  getShadowOpinion(snapshot: ArgusMarketSnapshot): Promise<ShadowOpinion | null>;
}

/**
 * The only real implementation in this repository. Always returns null - there is no external
 * TradingAgents process to call. A future, explicitly-authorized adapter would replace this with
 * a real (still non-negotiable-contract-bound) implementation; until then, this is what
 * isTradingAgentsShadowEnabled()'s config wiring would resolve to even if something did call it.
 */
export class NullTradingAgentsShadowAdapter implements TradingAgentsShadowAdapter {
  async getShadowOpinion(_snapshot: ArgusMarketSnapshot): Promise<ShadowOpinion | null> {
    return null;
  }
}

export const tradingAgentsShadowAdapter: TradingAgentsShadowAdapter = new NullTradingAgentsShadowAdapter();

export { isTradingAgentsShadowEnabled };
