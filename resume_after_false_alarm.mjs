import 'dotenv/config';
import { tradingEngine } from './src/server/engines/TradingEngine.ts';
import { BrokerManager } from './src/brokers/BrokerManager.ts';

await BrokerManager.getInstance().initialize();
await tradingEngine.initialize();

console.log('BEFORE: tradingState=', tradingEngine.state.tradingState);

const resumeResult = await tradingEngine.setTradingState('TRADING_ENABLED', {
  reason: 'False-alarm reconciliation mismatch (boot-order race checked against InternalPaperBroker instead of Alpaca before BrokerManager finished initializing - now fixed in server.ts). Verified directly against the real Alpaca /v2/positions endpoint: GLD (1 share, $403.67) and NVDA (1 share, $226.64) are both genuinely present. No real drift.',
  actor: 'operator',
});
console.log('RESUME:', JSON.stringify(resumeResult));
console.log('AFTER: tradingState=', tradingEngine.state.tradingState);
process.exit(0);
