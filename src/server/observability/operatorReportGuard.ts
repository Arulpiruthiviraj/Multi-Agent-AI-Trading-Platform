/**
 * Operator-report request guard (2026-10-14, Oct 14 freeze response).
 *
 * Incident: an operator diagnostic (rescue-outcomes) ran thousands of synchronous SQLite queries on the engine event loop and froze the engine ~6 min.
 * `guardHeavyReport` already serialized five reports and enforced a memory breaker, but 30+ other operator report routes (CLI diagnostics) were not under
 * it, so a burst of them could overlap and an unguarded one could run while another was in flight. This middleware puts every such route behind the same
 * mutex + memory breaker WITHOUT editing each handler: the whole request holds the heavy-report slot from entry until the response finishes or closes.
 *
 * Routes polled by the React UI (opportunity-snapshot, strategy-catalog, multi-horizon-outcomes) are deliberately NOT serialized - they would return 429s to
 * simultaneous dashboard panels; they are listed in UI_POLLED_REPORT_PATHS so the inventory test can require that choice to be explicit.
 *
 * HONEST LIMIT: this bounds overlap and memory, not the duration of a single synchronous query on the main thread. A single report must still avoid
 * per-item queries (see rescueOutcomeReport.ts) or move to selectRowsOffThread.
 */
import type { NextFunction, Request, Response } from 'express';
import { guardHeavyReport, HeavyReportRefusedError } from './heavyReportGuard';

export const OPERATOR_REPORT_PATHS: readonly string[] = [
  '/provider-health-matrix', '/consensus-report', '/daily-reflection', '/consensus-debate-health', '/execution-quality', '/trade-economic-attribution',
  '/forecast', '/daily-attribution', '/trading-funnel', '/portfolio-impact', '/calibration-drift', '/quant-evidence', '/reflection-engine-health',
  '/extended-hours-spread', '/why-no-trade', '/calibration-maturity', '/strategy-readiness', '/strategy-profitability', '/exploration-health',
  '/ai-cost-governor', '/discovery-lineage', '/market-data-diagnostics',
];

/** Report routes that the UI polls; intentionally not serialized by operatorReportGuard. */
export const UI_POLLED_REPORT_PATHS: readonly string[] = ['/opportunity-snapshot', '/strategy-catalog', '/multi-horizon-outcomes'];

export function operatorReportGuard(req: Request, res: Response, next: NextFunction): void {
  const name = `operator-report:${req.path}`;
  guardHeavyReport(name, () => new Promise<void>((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    next();
  })).catch((e: unknown) => {
    if (e instanceof HeavyReportRefusedError) {
      if (!res.headersSent) {
        res.status(e.code === 'TIMEOUT' ? 504 : 429).json({ ok: false, refused: true, code: e.code, error: e.message });
      }
      return;
    }
    if (!res.headersSent) next(e);
  });
}
