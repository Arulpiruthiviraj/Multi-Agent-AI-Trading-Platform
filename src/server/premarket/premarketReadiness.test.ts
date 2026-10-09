/**
 * Tests for the defect #6 readiness split (2026-10-08 code-only defect repair):
 * tradePlanPipelineHealthy vs premarketFocusReportHealthy are INDEPENDENT checks.
 *
 * The pure evaluators take injected evidence + clock, so every branch is asserted
 * deterministically. The key property: a missing focus report can never masquerade
 * as a dead pipeline, and a dead pipeline can never masquerade as a missing report.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateTradePlanPipeline,
  evaluateFocusReportHealth,
  type RefreshWindow,
} from './premarketReadiness';

const WINDOWS: RefreshWindow[] = [{ kind: 'TEST_WINDOW', startEt: '09:00', endEt: '09:30' }];
const DATE = '2026-10-08';

describe('evaluateTradePlanPipeline', () => {
  it('no plans -> WARN "no refresh completed yet" (never a false dead, never an error)', () => {
    const r = evaluateTradePlanPipeline(
      { tradingDate: DATE, planCount: 0, maxRefreshVersion: 0, firstActivityAt: null, lastActivityAt: null },
      new Date(`${DATE}T10:00:00-04:00`),
      WINDOWS,
    );
    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/no refresh completed yet/);
    expect(r.lastSuccessAt).toBeNull();
  });

  it('a fully-elapsed window with no activity since its start -> FAIL naming the missed window', () => {
    const r = evaluateTradePlanPipeline(
      {
        tradingDate: DATE,
        planCount: 3,
        maxRefreshVersion: 1,
        firstActivityAt: `${DATE}T08:00:00-04:00`,
        lastActivityAt: `${DATE}T08:00:00-04:00`,
      },
      new Date(`${DATE}T10:00:00-04:00`),
      WINDOWS,
    );
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/pipeline stall/);
    expect(r.detail).toMatch(/TEST_WINDOW/);
  });

  it('recent activity inside the window -> PASS with counts and timestamps', () => {
    const r = evaluateTradePlanPipeline(
      {
        tradingDate: DATE,
        planCount: 5,
        maxRefreshVersion: 2,
        firstActivityAt: `${DATE}T08:00:00-04:00`,
        lastActivityAt: `${DATE}T09:15:00-04:00`,
      },
      new Date(`${DATE}T10:00:00-04:00`),
      WINDOWS,
    );
    expect(r.status).toBe('PASS');
    expect(r.detail).toMatch(/5 plans/);
    expect(r.lastSuccessAt).toBe(`${DATE}T09:15:00-04:00`);
  });

  it('a window that has not elapsed yet cannot FAIL (late engine start is not a stall)', () => {
    const r = evaluateTradePlanPipeline(
      {
        tradingDate: DATE,
        planCount: 2,
        maxRefreshVersion: 1,
        firstActivityAt: `${DATE}T08:00:00-04:00`,
        lastActivityAt: `${DATE}T08:00:00-04:00`,
      },
      new Date(`${DATE}T09:15:00-04:00`), // inside the 09:00-09:30 window
      WINDOWS,
    );
    expect(r.status).toBe('PASS');
  });
});

describe('evaluateFocusReportHealth', () => {
  it('no completed refresh -> WARN "no refresh completed yet" (absence reported, not corrupt)', () => {
    const r = evaluateFocusReportHealth({ tradingDate: DATE, latestCompletedRefreshVersion: 0, latestReport: null });
    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/no refresh completed yet/);
    expect(r.lastSuccessAt).toBeNull();
  });

  it('completed refresh but no report row -> WARN naming the subscriber gap (independent of pipeline)', () => {
    const r = evaluateFocusReportHealth({ tradingDate: DATE, latestCompletedRefreshVersion: 3, latestReport: null });
    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/no focus report row exists/);
  });

  it('report matches the latest completed refresh -> PASS', () => {
    const r = evaluateFocusReportHealth({
      tradingDate: DATE,
      latestCompletedRefreshVersion: 3,
      latestReport: { refreshVersion: 3, generatedAt: `${DATE}T09:35:00-04:00` },
    });
    expect(r.status).toBe('PASS');
    expect(r.lastSuccessAt).toBe(`${DATE}T09:35:00-04:00`);
  });

  it('stale report (older than latest refresh) -> WARN, never a false healthy', () => {
    const r = evaluateFocusReportHealth({
      tradingDate: DATE,
      latestCompletedRefreshVersion: 4,
      latestReport: { refreshVersion: 2, generatedAt: `${DATE}T09:10:00-04:00` },
    });
    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/stale/);
  });

  it('report ahead of the latest completed refresh -> WARN version skew, never a false healthy', () => {
    const r = evaluateFocusReportHealth({
      tradingDate: DATE,
      latestCompletedRefreshVersion: 2,
      latestReport: { refreshVersion: 5, generatedAt: `${DATE}T09:40:00-04:00` },
    });
    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/version skew/);
  });
});

describe('defect #6 independence property', () => {
  it('pipeline PASS + missing report: the two checks disagree honestly', () => {
    const pipeline = evaluateTradePlanPipeline(
      {
        tradingDate: DATE,
        planCount: 5,
        maxRefreshVersion: 2,
        firstActivityAt: `${DATE}T08:00:00-04:00`,
        lastActivityAt: `${DATE}T09:15:00-04:00`,
      },
      new Date(`${DATE}T10:00:00-04:00`),
      WINDOWS,
    );
    const report = evaluateFocusReportHealth({
      tradingDate: DATE,
      latestCompletedRefreshVersion: 2,
      latestReport: null,
    });
    expect(pipeline.status).toBe('PASS');
    expect(report.status).toBe('WARN');
  });

  it('pipeline stalled + report present for an older refresh: the two checks disagree honestly', () => {
    const pipeline = evaluateTradePlanPipeline(
      {
        tradingDate: DATE,
        planCount: 3,
        maxRefreshVersion: 1,
        firstActivityAt: `${DATE}T08:00:00-04:00`,
        lastActivityAt: `${DATE}T08:00:00-04:00`,
      },
      new Date(`${DATE}T10:00:00-04:00`),
      WINDOWS,
    );
    const report = evaluateFocusReportHealth({
      tradingDate: DATE,
      latestCompletedRefreshVersion: 1,
      latestReport: { refreshVersion: 1, generatedAt: `${DATE}T08:05:00-04:00` },
    });
    expect(pipeline.status).toBe('FAIL');
    expect(report.status).toBe('PASS');
  });
});
