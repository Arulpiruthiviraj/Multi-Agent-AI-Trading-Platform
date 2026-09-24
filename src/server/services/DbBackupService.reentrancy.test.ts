import { describe, it, expect, vi } from 'vitest';

/**
 * Batch 2 timer/reentrancy sweep (2026-09-23): DbBackupService.runBackup() copies a real (and
 * potentially multi-GB) database file. start() now runs runBackup() through a singleFlightGuard
 * (backupGuard) so an overlapping call while a backup is still in flight is a real no-op, never a
 * second concurrent copy. This test proves the guard actually gates the private backupGuard field
 * wired in start(), not just that the shared primitive works in isolation (already covered by
 * singleFlightInterval.test.ts).
 */
describe('DbBackupService reentrancy guard', () => {
  it('a second call while the first is still in flight does not run runBackup twice', async () => {
    const { DbBackupService } = await import('./DbBackupService');
    const svc = new DbBackupService();

    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const runBackupSpy = vi.spyOn(svc, 'runBackup').mockImplementation(async () => { await gate; });

    const guard = (svc as any).backupGuard;
    const first = guard.run(() => svc.runBackup());
    const second = guard.run(() => svc.runBackup());

    expect(runBackupSpy).toHaveBeenCalledTimes(1); // second call coalesced synchronously, before awaiting

    resolveFirst();
    await Promise.all([first, second]);

    expect(runBackupSpy).toHaveBeenCalledTimes(1);
    runBackupSpy.mockRestore();
  });
});
