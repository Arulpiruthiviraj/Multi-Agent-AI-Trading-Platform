import { Router } from 'express';
import {
  continuousIntelligence,
  isOpportunityLoopEnabled,
  isPortfolioIntelEnabled,
} from '../config/continuousIntelligence';
import { getLastOpportunityScan } from '../continuous/OpportunityDiscovery';
import { marketDataWorker } from '../services/MarketDataWorker';

export const continuousIntelRouter = Router();

continuousIntelRouter.get('/status', (_req, res) => {
  res.json({
    ok: true,
    live: 'NO-GO',
    opportunityLoopEnabled: isOpportunityLoopEnabled(),
    portfolioIntelEnabled: isPortfolioIntelEnabled(),
    honesty: continuousIntelligence.honesty,
    entryConsensusUnchanged: true,
    consensusNote: 'ChiefTrader min-agents and 0.75 bar are unchanged. Risk-exit SELL from PortfolioManager still skips entry quorum and still hits RiskEngine/OMS.',
    maxActiveSubscriptions: continuousIntelligence.maxActiveSubscriptions,
    activeSymbols: marketDataWorker.getActiveSymbols(),
    lastOpportunityScan: getLastOpportunityScan(),
    ideasEmittedByScanner: 0,
  });
});
