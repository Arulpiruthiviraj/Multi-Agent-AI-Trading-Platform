/**
 * Soft-lock NEW BUY idea generation after a failed first-fill forensic checkpoint.
 *
 * Not EMERGENCY_STOP / not a second kill switch. Cleared only by explicit operator/test reset.
 * SELL / risk-exit path is not gated here (ChiefTrader isRiskExit).
 */
let forensicBuyLocked = false;
let forensicBuyLockReason: string | null = null;
let forensicBuyLockedAt: string | null = null;

export function isForensicCheckpointBuyLocked(): boolean {
  return forensicBuyLocked === true;
}

export function setForensicCheckpointBuyLock(reason: string): void {
  forensicBuyLocked = true;
  forensicBuyLockReason = reason;
  forensicBuyLockedAt = new Date().toISOString();
}

export function clearForensicCheckpointBuyLock(): void {
  forensicBuyLocked = false;
  forensicBuyLockReason = null;
  forensicBuyLockedAt = null;
}

export function getForensicCheckpointBuyLockInfo(): {
  locked: boolean;
  reason: string | null;
  lockedAt: string | null;
} {
  return {
    locked: forensicBuyLocked,
    reason: forensicBuyLockReason,
    lockedAt: forensicBuyLockedAt,
  };
}

export function resetForensicCheckpointBuyLockForTests(): void {
  clearForensicCheckpointBuyLock();
}
