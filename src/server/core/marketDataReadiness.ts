import { marketDataWorker } from '../services/MarketDataWorker';
import { evaluateQuoteFreshness } from './marketDataQuality';

/** Read-only feed evidence. Occupied subscription slots are not proof of usable quotes. */
export function getMarketDataReadiness() {
  const connected = marketDataWorker.isConnected();
  const symbols = marketDataWorker.getActiveSymbols();
  let freshSymbols = 0;
  for (const symbol of symbols) {
    const price = marketDataWorker.getLatestPrice(symbol);
    if (price !== null && Number.isFinite(price) && price > 0
      && evaluateQuoteFreshness({ priceAgeMs: marketDataWorker.getLatestPriceAgeMs(symbol) }).passed) {
      freshSymbols++;
    }
  }
  return {
    connected,
    activeSymbols: symbols.length,
    freshSymbols,
    ready: connected && freshSymbols > 0,
    detail: `${connected ? 'connected' : 'disconnected'}; ${freshSymbols}/${symbols.length} active symbols have a valid fresh quote`,
  };
}
