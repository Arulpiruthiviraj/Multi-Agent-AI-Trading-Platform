export interface RiskEvaluationRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  currentPrice: number;
  confidence: number;
}

export interface PortfolioState {
  totalEquity: number;
  availableCash: number;
  dailyRealizedPnL: number;
  maxDrawdown: number;
  portfolioHeat: number; // 0 to 1 scale of overall volatility exposure
  marketRegime: 'BULL' | 'BEAR' | 'CHOPPY';
  openPositions: { symbol: string, quantity: number, currentPrice: number, volatility: number }[];
}

export interface RiskEvaluationResult {
  approved: boolean;
  maxQuantity: number;
  reasoning: string;
}

export class RiskEngine {
  private dailyLossLimit = 2500;
  private maxPositionConcentration = 0.20;
  private maxSectorExposure = 0.30; 
  private maxPortfolioHeat = 0.85;

  private symbolToSector: Record<string, string> = {
    'AAPL': 'Technology', 'NVDA': 'Technology', 'MSFT': 'Technology',
    'TSLA': 'Consumer Discretionary', 'JPM': 'Financials', 'V': 'Financials',
    'SPY': 'ETF', 'QQQ': 'ETF'
  };

  public evaluateRisk(request: RiskEvaluationRequest, portfolio: PortfolioState): RiskEvaluationResult {
    if (portfolio.dailyRealizedPnL < -this.dailyLossLimit) {
      return { approved: false, maxQuantity: 0, reasoning: `Daily loss limit of $${this.dailyLossLimit} exceeded (Current: $${portfolio.dailyRealizedPnL.toFixed(2)}). Trading halted.` };
    }

    if (portfolio.maxDrawdown > 0.15) {
       return { approved: false, maxQuantity: 0, reasoning: `Maximum drawdown of 15% breached. System in capital preservation mode.` };
    }

    if (request.side === 'SELL') {
      const position = portfolio.openPositions.find(p => p.symbol === request.symbol);
      const heldQty = position ? position.quantity : 0;
      return { approved: true, maxQuantity: heldQty || 100, reasoning: "Sell order approved to reduce risk exposure." };
    }

    if (portfolio.portfolioHeat > this.maxPortfolioHeat) {
       return { approved: false, maxQuantity: 0, reasoning: `Portfolio heat (${portfolio.portfolioHeat.toFixed(2)}) exceeds maximum threshold of ${this.maxPortfolioHeat}.` };
    }

    if (portfolio.marketRegime === 'BEAR' && request.confidence < 0.85) {
       return { approved: false, maxQuantity: 0, reasoning: `Market regime is BEAR. Buy confidence (${request.confidence}) is below 0.85 required for counter-trend entries.` };
    }

    const sector = this.symbolToSector[request.symbol] || 'Unknown';
    let currentSectorExposure = 0;
    for (const pos of portfolio.openPositions) {
      const posSector = this.symbolToSector[pos.symbol] || 'Unknown';
      if (posSector === sector) {
        currentSectorExposure += pos.quantity * pos.currentPrice;
      }
    }

    const maxAllowedSectorValue = portfolio.totalEquity * this.maxSectorExposure;
    if (currentSectorExposure >= maxAllowedSectorValue) {
      return { approved: false, maxQuantity: 0, reasoning: `Max sector exposure of ${(this.maxSectorExposure*100).toFixed(0)}% reached for sector [${sector}].` };
    }

    const maxAllocValue = portfolio.totalEquity * this.maxPositionConcentration;
    const existingPosition = portfolio.openPositions.find(p => p.symbol === request.symbol);
    const existingValue = existingPosition ? existingPosition.quantity * existingPosition.currentPrice : 0;
    
    const remainingAlloc = maxAllocValue - existingValue;
    if (remainingAlloc <= 0) {
      return { approved: false, maxQuantity: 0, reasoning: `Max position concentration of ${(this.maxPositionConcentration*100).toFixed(0)}% reached for ${request.symbol}.` };
    }

    const remainingSectorAlloc = maxAllowedSectorValue - currentSectorExposure;
    
    // Gap risk and Liquidity check simulation
    const liquidityPenalty = request.symbol === 'UNKNOWN' ? 0.5 : 1.0;
    const maxAffordableByCash = portfolio.availableCash * liquidityPenalty;
    
    const actualAlloc = Math.min(remainingAlloc, remainingSectorAlloc, maxAffordableByCash);
    
    if (actualAlloc < request.currentPrice) {
       return { approved: false, maxQuantity: 0, reasoning: "Insufficient capital after concentration, sector, and liquidity constraints." };
    }

    // Dynamic Position Sizing based on Volatility Adjustment
    const estimatedVolatility = 0.05; // 5% daily move
    const maxLossTolerance = portfolio.totalEquity * 0.01; // 1% risk per trade
    const volatilityAdjustedAlloc = maxLossTolerance / estimatedVolatility;

    const finalAlloc = Math.min(actualAlloc, volatilityAdjustedAlloc);
    const maxQuantity = Math.floor(finalAlloc / request.currentPrice);

    if (maxQuantity <= 0) {
       return { approved: false, maxQuantity: 0, reasoning: "Volatility-adjusted position size is zero. Trade too risky." };
    }

    return {
      approved: true,
      maxQuantity,
      reasoning: `Risk validated. Sector [${sector}] OK. Market Regime: ${portfolio.marketRegime}. Max Size: ${maxQuantity} shares.`
    };
  }
}

export const riskEngine = new RiskEngine();
