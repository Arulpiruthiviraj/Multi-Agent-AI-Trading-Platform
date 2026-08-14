import dotenv from 'dotenv';
dotenv.config();
import { historicalDataGateway } from '../src/server/engines/backtest/HistoricalDataGateway';

async function main() {
  await historicalDataGateway.ensureBars('AAPL', '1Day', new Date('2024-01-01').getTime(), new Date('2024-02-01').getTime());
  const bars = await historicalDataGateway.getBars('AAPL', '1Day', new Date('2024-01-01').getTime(), new Date('2024-02-01').getTime());
  console.log('Got', bars.length, 'bars. First:', JSON.stringify(bars[0]), 'Last:', JSON.stringify(bars[bars.length - 1]));
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
