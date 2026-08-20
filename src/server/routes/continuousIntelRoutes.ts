import { Router } from 'express';
import {
  continuousIntelligence,
  isOpportunityIdeasEnabled,
  isOpportunityLoopEnabled,
  isPortfolioIntelEnabled,
} from '../config/continuousIntelligence';
import { getLastOpportunityScan } from '../continuous/OpportunityDiscovery';
import { listCandidates } from '../continuous/candidateLifecycle';
import { getPipelineRateSnapshot } from '../core/pipelineRateLimit';
import { marketDataWorker } from '../services/MarketDataWorker';

export const continuousIntelRouter = Router();

continuousIntelRouter.get('/status', (_req, res) => {
  res.json({
    ok: true,
    live: 'NO-GO',
    opportunityLoopEnabled: isOpportunityLoopEnabled(),
    opportunityIdeasEnabled: isOpportunityIdeasEnabled(),
    portfolioIntelEnabled: isPortfolioIntelEnabled(),
    honesty: continuousIntelligence.honesty,
    entryConsensusUnchanged: true,
    consensusNote: 'ChiefTrader min-agents and 0.75 bar are unchanged. Risk-exit SELL from PortfolioManager still skips entry quorum and still hits RiskEngine/OMS.',
    maxActiveSubscriptions: continuousIntelligence.maxActiveSubscriptions,
    activeSymbols: marketDataWorker.getActiveSymbols(),
    lastOpportunityScan: getLastOpportunityScan(),
    candidates: listCandidates(),
    pipelineRate: getPipelineRateSnapshot(),
    ideasEmittedByScanner: 0,
  });
});
