/**
 * Durable replay artifacts under data/replays (or ARGUS_REPLAY_DIR). Not SQLite bars.
 */
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReplayEvent } from './ReplayContext';
import { buildZipArchive } from './zipArchive';

export function replayRootDir(): string {
  if (process.env.ARGUS_REPLAY_DIR) return process.env.ARGUS_REPLAY_DIR;
  return join(process.cwd(), 'data', 'replays');
}

// Real replay IDs are always crypto.randomUUID() (FullArgusReplayEngine.ts). Validating the
// format here - the one chokepoint every function in this file joins a replayId into a
// filesystem path through - closes a real path-traversal bug: replayDir() used to join
// req.params.id straight into a path with zero sanitization, so an id like "../../../etc" could
// list or read files outside data/replays entirely via the export routes.
const REPLAY_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidReplayId(replayId: string): boolean {
  return typeof replayId === 'string' && REPLAY_ID_PATTERN.test(replayId);
}

export function replayDir(replayId: string): string {
  if (!isValidReplayId(replayId)) {
    throw new Error(`Invalid replayId (must be a UUID): ${JSON.stringify(replayId)}`);
  }
  return join(replayRootDir(), replayId);
}

export function ensureReplayDir(replayId: string): string {
  const dir = replayDir(replayId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function appendReplayEvent(replayId: string, event: ReplayEvent): void {
  const dir = ensureReplayDir(replayId);
  appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
}

export function writeReplayJson(replayId: string, name: string, value: unknown): void {
  const dir = ensureReplayDir(replayId);
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

export function readReplayJson<T>(replayId: string, name: string): T | null {
  const p = join(replayDir(replayId), name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function listReplayPackages(): string[] {
  const root = replayRootDir();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => existsSync(join(root, n, 'summary.json')));
}

export function exportReplayManifest(replayId: string): Record<string, string> {
  const dir = replayDir(replayId);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return { replayId, dir, files: files.join(',') };
}

export function readReplayArtifact(replayId: string, name: string): { content: string; contentType: string } | null {
  const p = join(replayDir(replayId), name);
  if (!existsSync(p)) return null;
  const content = readFileSync(p, 'utf8');
  if (name.endsWith('.jsonl')) return { content, contentType: 'application/x-ndjson' };
  if (name.endsWith('.csv')) return { content, contentType: 'text/csv' };
  return { content, contentType: 'application/json' };
}

/** Build a trades CSV from trades.json (or empty). */
export function exportTradesCsv(replayId: string): string {
  const trades = readReplayJson<Array<Record<string, unknown>>>(replayId, 'trades.json') || [];
  const header = 'timestamp,symbol,side,quantity,price,strategyId,traceId,realizedPnl,executionModel,executionEnvironment';
  const rows = trades.map((t) =>
    [t.timestamp, t.symbol, t.side, t.quantity, t.price, t.strategyId, t.traceId, t.realizedPnl ?? '', t.executionModel, t.executionEnvironment].join(',')
  );
  return [header, ...rows].join('\n');
}

export function exportEquityCsv(replayId: string): string {
  const equity = readReplayJson<Array<{ t: number; equity: number; cash: number; drawdownPct: number }>>(replayId, 'equity_curve.json') || [];
  const header = 't,equity,cash,drawdownPct';
  const rows = equity.map((e) => [e.t, e.equity, e.cash, e.drawdownPct].join(','));
  return [header, ...rows].join('\n');
}

function csvField(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportRejectionsCsv(replayId: string): string {
  const rejections = readReplayJson<Array<Record<string, unknown>>>(replayId, 'rejected_orders.json') || [];
  const header = 'timestamp,symbol,side,reason,traceId,rejectionGate';
  const rows = rejections.map((r) => [r.timestamp, r.symbol, r.side, r.reason, r.traceId ?? '', r.rejectionGate ?? ''].map(csvField).join(','));
  return [header, ...rows].join('\n');
}

/** AFTER-THE-FACT ANALYSIS export - see MissedOpportunityAnalysis.ts. */
export function exportMissedOpportunitiesCsv(replayId: string): string {
  const rows = readReplayJson<Array<Record<string, unknown>>>(replayId, 'missed_opportunities.json') || [];
  const header = 'symbol,timestamp,reason,referencePrice,horizonBars,barsAvailableAfterRejection,maxFavorableExcursionPct,maxAdverseExcursionPct,returnAtHorizonPct,classification';
  const lines = rows.map((r) => [
    r.symbol, r.timestamp, r.reason, r.referencePrice, r.horizonBars, r.barsAvailableAfterRejection,
    r.maxFavorableExcursionPct, r.maxAdverseExcursionPct, r.returnAtHorizonPct ?? '', r.classification,
  ].map(csvField).join(','));
  return [header, ...lines].join('\n');
}

/** Machine-analysis export — agent votes, risk gates, forward MFE/MAE (AFTER-THE-FACT). */
export function exportDecisionEvidenceCsv(replayId: string): string {
  const rows = readReplayJson<Array<Record<string, unknown>>>(replayId, 'decision_evidence.json') || [];
  const header = 'symbol,timestamp,strategyId,predictedSide,referencePrice,stageOutcome,consensusApproved,weightedConfidence,independentAgreeingAgents,rejectionGate,forwardReturnPct,mfePct,maePct,agentVotesJson';
  const lines = rows.map((r) => [
    r.symbol, r.timestamp, r.strategyId, r.predictedSide, r.referencePrice, r.stageOutcome,
    r.consensusApproved, r.weightedConfidence, r.independentAgreeingAgents, r.rejectionGate ?? '',
    r.forwardReturnPct ?? '', r.mfePct ?? '', r.maePct ?? '',
    JSON.stringify(r.agentVotes ?? []),
  ].map(csvField).join(','));
  return [header, ...lines].join('\n');
}

/**
 * Bundles every generated artifact for a replay into one ZIP, using buildZipArchive (real,
 * STORE-method, independently verified against PowerShell's Expand-Archive). Only includes files
 * that actually exist for this run - a replay with zero trades still exports a valid archive with
 * whatever artifacts were actually written, not fabricated placeholders.
 */
export function exportZipArchive(replayId: string): Buffer {
  const candidateFiles = [
    'summary.json', 'configuration.json', 'dataset.json', 'trades.json', 'rejected_orders.json',
    'missed_opportunities.json', 'decision_evidence.json', 'portfolio_final.json', 'equity_curve.json', 'events.jsonl', 'README.json',
  ];
  const entries: Array<{ name: string; content: string }> = [];
  for (const name of candidateFiles) {
    const art = readReplayArtifact(replayId, name);
    if (art) entries.push({ name, content: art.content });
  }
  entries.push({ name: 'trades.csv', content: exportTradesCsv(replayId) });
  entries.push({ name: 'equity_curve.csv', content: exportEquityCsv(replayId) });
  entries.push({ name: 'rejections.csv', content: exportRejectionsCsv(replayId) });
  entries.push({ name: 'missed_opportunities.csv', content: exportMissedOpportunitiesCsv(replayId) });
  entries.push({ name: 'decision_evidence.csv', content: exportDecisionEvidenceCsv(replayId) });
  entries.push({ name: 'report.md', content: exportMarkdownReport(replayId) });
  return buildZipArchive(entries);
}

/** Human-readable summary. Not a substitute for the JSON export - a reviewer-facing overview. */
export function exportMarkdownReport(replayId: string): string {
  const summary = readReplayJson<Record<string, any>>(replayId, 'summary.json');
  if (!summary) return `# Replay ${replayId}\n\nNo summary.json found for this replay id.\n`;
  const r = summary.report || {};
  const funnel = summary.decisionFunnel || {};
  const agentEval = summary.agentEvaluation || {};
  const missed = summary.missedOpportunities || [];
  const discovered = summary.discoveredSymbols || [];

  const lines: string[] = [];
  lines.push(`# Argus Historical Replay Report — ${replayId}`);
  lines.push('');
  lines.push('**HISTORICAL_SIMULATION · NOT LIVE · NOT PAPER · NOT ORGANIC_PAPER**');
  lines.push('');
  lines.push('## Configuration');
  lines.push(`- Universe source: ${summary.universeSource}`);
  lines.push(`- Methodology: ${summary.historicalUniverseMethodology}`);
  lines.push(`- Data availability: ${summary.dataAvailabilityWarning}`);
  lines.push(`- Partial-fill model: ${summary.partialFillModel}`);
  lines.push(`- Dataset hash: ${summary.hashes?.datasetHash}`);
  lines.push(`- Configuration hash: ${summary.hashes?.configurationHash}`);
  lines.push(`- Replay hash: ${summary.hashes?.replayHash}`);
  lines.push('');
  lines.push('## Portfolio performance');
  lines.push(`- Starting capital: ${r.startingCapital}`);
  lines.push(`- Ending equity: ${r.endingCapital}`);
  lines.push(`- Net P&L: ${r.netPnl} (${r.netReturnPct?.toFixed?.(2)}%)`);
  lines.push(`- Max drawdown: ${r.maxDrawdown} (${r.maxDrawdownPct?.toFixed?.(2)}%)`);
  lines.push(`- Trades: ${r.totalTrades} (BUY ${r.buyTrades} / SELL ${r.sellTrades})`);
  lines.push(`- Win rate: ${r.winRate != null ? (r.winRate * 100).toFixed(1) + '%' : 'N/A'}`);
  lines.push(`- Profit factor: ${r.profitFactor ?? 'N/A'}`);
  lines.push(`- Sharpe: ${r.sharpe?.status === 'OK' ? r.sharpe.value?.toFixed(3) : r.sharpe?.status}`);
  lines.push('');
  lines.push('## Decision funnel');
  lines.push(`- Evaluations attempted: ${funnel.evaluationsAttempted}`);
  lines.push(`- Analyzed: ${funnel.analyzed}`);
  lines.push(`- Ideas generated: ${funnel.ideasGenerated}`);
  lines.push(`- Consensus approved: ${funnel.consensusApproved} / rejected: ${funnel.consensusRejected}`);
  lines.push(`- Orders submitted: ${funnel.ordersSubmitted}, filled: ${funnel.ordersFilled}, rejected: ${funnel.ordersRejected}`);
  lines.push('');
  if (discovered.length) {
    lines.push('## Discovered symbols');
    lines.push(discovered.map((d: any) => `${d.symbol} (t=${d.discoveredAt})`).join(', '));
    lines.push('');
  }
  lines.push('## Agent evaluation');
  for (const [agent, stat] of Object.entries<any>(agentEval)) {
    lines.push(`- ${agent}: ${stat.ideas} ideas (${stat.buyIdeas} BUY / ${stat.sellIdeas} SELL), avg confidence ${stat.averageConfidence ?? 'N/A'}`);
  }
  lines.push('');
  lines.push(`## Missed opportunities (${summary.missedOpportunityLabel || 'AFTER-THE-FACT ANALYSIS'})`);
  lines.push(`${missed.length} consensus rejections analyzed retrospectively.`);
  const flagged = missed.filter((m: any) => m.classification === 'MISSED_OPPORTUNITY');
  lines.push(`${flagged.length} classified MISSED_OPPORTUNITY (favorable move exceeded threshold after rejection).`);
  lines.push('');
  const decSummary = summary.decisionEvidenceSummary || summary.predictionOutcomeEvidence || {};
  lines.push('## Decision evidence (prediction vs outcome)');
  lines.push(`- Schema: ${decSummary.schema || 'argus.historical_decision_evidence.v1'}`);
  lines.push(`- Records: ${decSummary.count ?? (summary.decisionEvidence || []).length}`);
  lines.push(`- With forward outcome: ${decSummary.withForwardOutcome ?? 'N/A'}`);
  if (decSummary.byStageOutcome) {
    lines.push(`- By stage: ${JSON.stringify(decSummary.byStageOutcome)}`);
  }
  lines.push(`- AI mode honesty: ${summary.ai?.honesty?.reason || summary.historicalEvaluation?.aiModeHonesty?.reason || 'see replaySafety.aiModeHonestyDescription'}`);
  lines.push('');
  lines.push('## Honesty');
  for (const h of r.honesty || []) lines.push(`- ${h}`);
  lines.push('');
  return lines.join('\n');
}
