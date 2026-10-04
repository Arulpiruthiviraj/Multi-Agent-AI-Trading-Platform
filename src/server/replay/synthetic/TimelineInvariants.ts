/**
 * Timeline invariant checks for the Synthetic Market Session Simulator (2026-10-04).
 *
 * CertificationGate used to only COUNT timeline events (ideas, approvals, fills). Counting
 * cannot catch the defect classes that actually hurt in production:
 *   - an order submitted without a risk approval (risk bypass)
 *   - a fill recorded without a submitted order (phantom fill — this exact class
 *     previously escaped into historical replay as phantom short fills)
 *   - a chief approval without a consensus debate (consensus bypass)
 *   - orders placed while the feed was in a known outage window (DATA_INTERRUPTION)
 *
 * These checks read causal ORDERING off the real pipeline's own event timeline (simulated-time
 * ordered), linked by traceId — which EventBus.assertTraceId enforces on every core event, so
 * linkage is a real pipeline property, not a test fiction. Any FAIL-severity violation fails
 * certification outright, in both Test A and Test B shapes: a safety invariant is not a
 * "tradeable scenario" concern, it is unconditional.
 *
 * Pure function over a readonly timeline — no Argus imports, trivially unit-testable.
 */
import type { TimelineEntry } from './DecisionTimeline';
import { getScenario } from './SyntheticScenario';

export type ViolationCode =
  | 'RISK_BYPASS'
  | 'PHANTOM_FILL'
  | 'CONSENSUS_BYPASS'
  | 'ORDER_DURING_OUTAGE'
  | 'UNLINKED_ORDER';

export interface TimelineViolation {
  code: ViolationCode;
  /** FAIL fails certification; WARN is surfaced for operator review without failing. */
  severity: 'FAIL' | 'WARN';
  detail: string;
  traceId: string | null;
  symbol: string | null;
  /** Timeline sequence number of the offending event. */
  seq: number;
}

export interface OutageWindow {
  /** Simulated-time bounds (ms, same clock as TimelineEntry.simulatedTimeMs). */
  fromMs: number;
  toMs: number;
  label: string;
}

/**
 * Derives feed-outage windows from a scenario's own DATA_INTERRUPTION events, so the
 * ORDER_DURING_OUTAGE check stays in sync with scenario definitions instead of
 * hardcoding minute offsets here.
 */
export function outageWindowsForScenario(scenarioId: string, sessionStartMs: number): OutageWindow[] {
  let scenario;
  try {
    scenario = getScenario(scenarioId);
  } catch {
    return [];
  }
  const windows: OutageWindow[] = [];
  for (const evt of scenario.events) {
    if (evt.type !== 'DATA_INTERRUPTION') continue;
    const bars = evt.interruptionBars ?? 10;
    const fromMs = sessionStartMs + evt.atOffsetMs;
    windows.push({
      fromMs,
      toMs: fromMs + bars * 60_000,
      label: `DATA_INTERRUPTION @+${Math.round(evt.atOffsetMs / 60000)}min (${bars} bars)`,
    });
  }
  return windows;
}

function approvedRiskFor(traceId: string | null, prior: TimelineEntry[]): boolean {
  return prior.some(
    (e) =>
      e.eventType === 'RISK_ASSESSMENT_COMPLETED' &&
      e.summary['approved'] === true &&
      (traceId === null || e.traceId === traceId),
  );
}

function orderIdOf(e: TimelineEntry): string | null {
  const s = e.summary;
  const id = s['orderId'] ?? s['id'];
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

export function checkTimelineInvariants(
  timeline: readonly TimelineEntry[],
  opts: { outageWindows?: OutageWindow[] } = {},
): TimelineViolation[] {
  const violations: TimelineViolation[] = [];
  const outageWindows = opts.outageWindows ?? [];

  // Entries arrive in seq order, but sort defensively — every check below is
  // "was there a qualifying event strictly before this one".
  const ordered = [...timeline].sort((a, b) => a.seq - b.seq);

  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    const prior = ordered.slice(0, i);

    if (e.eventType === 'ORDER_SUBMITTED') {
      // 1. Risk approval must causally precede every order.
      if (!approvedRiskFor(e.traceId, prior)) {
        violations.push({
          code: 'RISK_BYPASS',
          severity: 'FAIL',
          detail: `ORDER_SUBMITTED seq=${e.seq} has no preceding approved RISK_ASSESSMENT_COMPLETED` +
            (e.traceId ? ` for traceId=${e.traceId}` : ' (and no traceId to link by — and no approved assessment at all)'),
          traceId: e.traceId,
          symbol: e.symbol,
          seq: e.seq,
        });
      } else if (e.traceId === null) {
        violations.push({
          code: 'UNLINKED_ORDER',
          severity: 'WARN',
          detail: `ORDER_SUBMITTED seq=${e.seq} carries no traceId — an approved risk assessment exists but linkage is unverifiable`,
          traceId: null,
          symbol: e.symbol,
          seq: e.seq,
        });
      }
      // 2. No orders inside a known feed-outage window.
      for (const w of outageWindows) {
        if (e.simulatedTimeMs >= w.fromMs && e.simulatedTimeMs < w.toMs) {
          violations.push({
            code: 'ORDER_DURING_OUTAGE',
            severity: 'FAIL',
            detail: `ORDER_SUBMITTED seq=${e.seq} at ${e.simulatedTimeIso} falls inside outage window "${w.label}" — the pipeline must not trade on a dead feed`,
            traceId: e.traceId,
            symbol: e.symbol,
            seq: e.seq,
          });
        }
      }
    }

    if (e.eventType === 'ORDER_FILLED' || e.eventType === 'ORDER_EXECUTED') {
      // 3. Every fill must correspond to a submitted order (phantom-fill guard).
      const oid = orderIdOf(e);
      const linked = prior.some((p) => {
        if (p.eventType !== 'ORDER_SUBMITTED') return false;
        if (oid !== null && orderIdOf(p) === oid) return true;
        return e.traceId !== null && p.traceId === e.traceId;
      });
      if (!linked) {
        violations.push({
          code: 'PHANTOM_FILL',
          severity: 'FAIL',
          detail: `${e.eventType} seq=${e.seq} has no preceding ORDER_SUBMITTED` +
            (oid ? ` with orderId=${oid}` : '') +
            (e.traceId ? ` for traceId=${e.traceId}` : ' (and no traceId to link by)'),
          traceId: e.traceId,
          symbol: e.symbol,
          seq: e.seq,
        });
      }
    }

    if (e.eventType === 'CHIEF_APPROVED_IDEA') {
      // 4. Chief approval must follow a consensus debate for the same idea.
      const debated = prior.some(
        (p) =>
          (p.eventType === 'CHIEF_CONSENSUS_STARTED' || p.eventType === 'CHIEF_CONSENSUS_COMPLETED') &&
          (e.traceId === null || p.traceId === e.traceId),
      );
      if (!debated) {
        violations.push({
          code: 'CONSENSUS_BYPASS',
          severity: 'FAIL',
          detail: `CHIEF_APPROVED_IDEA seq=${e.seq} has no preceding consensus debate` +
            (e.traceId ? ` for traceId=${e.traceId}` : ''),
          traceId: e.traceId,
          symbol: e.symbol,
          seq: e.seq,
        });
      }
    }
  }

  return violations;
}
