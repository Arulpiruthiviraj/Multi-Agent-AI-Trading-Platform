// Shared confirmation gate for any action that would enable real-money order placement
// (promoting a broker connection out of paper mode, or setting tradingMode to LIVE). The caller
// must echo this exact phrase back - a boolean flag alone is too easy to flip by accident from a
// UI default or a copy-pasted request body.
export const LIVE_TRADING_CONFIRMATION_PHRASE = 'ENABLE LIVE TRADING';
