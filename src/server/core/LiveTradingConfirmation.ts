// Shared confirmation gate for any action that would enable real-money order placement
// (promoting a broker connection out of paper mode, or setting tradingMode to LIVE). The caller
// must echo this exact phrase back - a boolean flag alone is too easy to flip by accident from a
// UI default or a copy-pasted request body.
//
// Per-order defense: after LIVE is enabled, OMS / live Alpaca URLs still require this process to
// have been armed with the phrase in the current runtime. Restart clears the arm (fail-closed).
export const LIVE_TRADING_CONFIRMATION_PHRASE = 'ENABLE LIVE TRADING';

let liveOrdersArmed = false;

/** Arm live order placement for this process after the exact confirmation phrase is accepted. */
export function armLiveTrading(confirmationPhrase: string | undefined | null): boolean {
  if (confirmationPhrase !== LIVE_TRADING_CONFIRMATION_PHRASE) return false;
  liveOrdersArmed = true;
  return true;
}

/** Clear the runtime arm (paper revert, failed confirm, tests). */
export function disarmLiveTrading(): void {
  liveOrdersArmed = false;
}

export function isLiveTradingArmed(): boolean {
  return liveOrdersArmed;
}

/**
 * LIVE OMS / live-host broker calls must pass. Paper and UNKNOWN are not gated by the arm.
 * Restart without re-confirming leaves tradingMode=LIVE in SQLite but blocks placeOrder.
 */
export function assertLiveOrdersArmed(): { ok: boolean; reason: string } {
  if (liveOrdersArmed) return { ok: true, reason: 'LIVE_ARM_OK' };
  return {
    ok: false,
    reason: 'LIVE_ARM_REQUIRED: LIVE orders require ENABLE LIVE TRADING confirmation in this process. Re-confirm after restart; dual paperMode/tradingMode alone is not enough.',
  };
}
