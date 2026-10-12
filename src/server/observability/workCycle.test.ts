import { describe, it, expect, beforeEach } from 'vitest';
import { timedWorkCycle, getRecentWorkCycles, resetWorkCyclesForTests, type WorkCycleDeps, type WorkCycleRecord } from './workCycle';

function fakeDeps(): { deps: WorkCycleDeps; advance: (wall: number, cpu: number) => void; reports: WorkCycleRecord[] } {
  let wall = 0;
  let cpu = 0;
  const reports: WorkCycleRecord[] = [];
  return {
    deps: { nowMs: () => 1_000_000 + wall, monotonicMs: () => wall, cpuMs: () => cpu, slowWarnMs: 10_000, report: (r) => reports.push(r) },
    advance: (w, c) => { wall += w; cpu += c; },
    reports,
  };
}

describe('timedWorkCycle', () => {
  beforeEach(() => resetWorkCyclesForTests());

  it('reports a slow, CPU-bound run with its cpu share (the Oct-12 15-minute stall signature)', async () => {
    const f = fakeDeps();
    await timedWorkCycle('CalibrationValidationWorker', async () => { f.advance(240_000, 239_000); }, f.deps);
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0]).toMatchObject({ name: 'CalibrationValidationWorker', outcome: 'OK', slow: true });
    expect(f.reports[0].wallMs).toBe(240_000);
    expect(f.reports[0].cpuShare).toBeGreaterThan(0.99);
  });

  it('does not report a fast run, but still remembers it', async () => {
    const f = fakeDeps();
    await timedWorkCycle('X', async () => { f.advance(50, 10); }, f.deps);
    expect(f.reports).toHaveLength(0);
    expect(getRecentWorkCycles('X')).toHaveLength(1);
  });

  it('a slow wait that burns no CPU is reported with a low cpu share (a wait, not a loop hold)', async () => {
    const f = fakeDeps();
    await timedWorkCycle('Y', async () => { f.advance(60_000, 100); }, f.deps);
    expect(f.reports[0].cpuShare).toBeLessThan(0.01);
  });

  it('returns the job result unchanged', async () => {
    const f = fakeDeps();
    await expect(timedWorkCycle('Z', async () => 42, f.deps)).resolves.toBe(42);
  });

  it('rethrows the job error unchanged, records ERROR, and still reports when slow', async () => {
    const f = fakeDeps();
    const boom = new Error('boom');
    await expect(timedWorkCycle('E', async () => { f.advance(20_000, 1); throw boom; }, f.deps)).rejects.toBe(boom);
    expect(f.reports[0]).toMatchObject({ outcome: 'ERROR', slow: true });
  });

  it('a throwing reporter can never affect the job', async () => {
    const f = fakeDeps();
    f.deps.report = () => { throw new Error('logger down'); };
    await expect(timedWorkCycle('R', async () => { f.advance(20_000, 1); return 'ok'; }, f.deps)).resolves.toBe('ok');
  });

  it('keeps a bounded history per job', async () => {
    const f = fakeDeps();
    for (let i = 0; i < 45; i++) await timedWorkCycle('B', async () => { f.advance(1, 1); }, f.deps);
    expect(getRecentWorkCycles('B').length).toBe(20);
  });
});
