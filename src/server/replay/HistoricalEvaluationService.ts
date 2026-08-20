/**
 * Thin application facade for Argus Historical Evaluation.
 * Delegates to FullArgusReplayEngine — no duplicated execution logic.
 */
import type { ReplayConfig } from './ReplayContext';
import {
  createReplayRun,
  startReplay,
  getReplayRun,
  getReplayTrades,
  getReplayEquity,
  getReplayPortfolio,
  pauseReplay,
  resumeReplay,
  stopReplay,
  stepReplay,
} from './FullArgusReplayEngine';
import { exportReplayManifest, exportZipArchive, exportMarkdownReport } from './replayStore';

export type HistoricalEvaluationConfig = Partial<ReplayConfig>;

export async function createHistoricalEvaluation(body: HistoricalEvaluationConfig = {}) {
  return createReplayRun(body);
}

export async function startHistoricalEvaluation(id: string, opts?: { async?: boolean }) {
  return startReplay(id, opts);
}

export function getHistoricalEvaluation(id: string) {
  return getReplayRun(id);
}

export function getHistoricalEvaluationTrades(id: string) {
  return getReplayTrades(id);
}

export function getHistoricalEvaluationEquity(id: string) {
  return getReplayEquity(id);
}

export async function getHistoricalEvaluationPortfolio(id: string) {
  return getReplayPortfolio(id);
}

export function pauseHistoricalEvaluation(id: string) {
  return pauseReplay(id);
}

export function resumeHistoricalEvaluation(id: string) {
  return resumeReplay(id);
}

export function stopHistoricalEvaluation(id: string) {
  return stopReplay(id);
}

export function stepHistoricalEvaluation(id: string) {
  return stepReplay(id);
}

export function getHistoricalEvaluationReport(id: string) {
  const row = getReplayRun(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    replayId: row.replayId,
    status: row.status,
    report: row.report,
    decisionFunnel: row.decisionFunnel,
    agentAvailability: row.agentAvailability,
    agentEvaluation: row.agentEvaluation,
    historicalEvaluation: row.historicalEvaluation,
    missedOpportunities: row.missedOpportunities,
    missedOpportunityLabel: row.missedOpportunityLabel,
    live: row.live,
    executionEnvironment: row.executionEnvironment,
    organicPaper: row.organicPaper,
  };
}

export function exportHistoricalEvaluation(id: string, kind: 'zip' | 'markdown' | 'manifest' = 'zip') {
  if (kind === 'markdown') return exportMarkdownReport(id);
  if (kind === 'manifest') return exportReplayManifest(id);
  return exportZipArchive(id);
}
