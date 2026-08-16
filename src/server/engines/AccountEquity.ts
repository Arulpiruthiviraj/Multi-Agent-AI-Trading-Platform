/** Fail-closed broker equity / buying-power checks. Never invent a placeholder balance. */

export const INVALID_ACCOUNT_EQUITY = 'invalid_account_equity';

export function isPositiveFiniteMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
