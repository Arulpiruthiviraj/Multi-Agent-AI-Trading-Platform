import fs from 'fs';
let code = fs.readFileSync('src/server/core/SystemBootstrap.ts', 'utf8');

const importRecon = `import { portfolioReconciliationWorker } from '../services/PortfolioReconciliation';\n`;

if (!code.includes('portfolioReconciliationWorker')) {
  code = importRecon + code;
  code = code.replace('portfolioMonitor.start();', 'portfolioMonitor.start();\n    portfolioReconciliationWorker.start();');
  code = code.replace('portfolioMonitor.stop();', 'portfolioMonitor.stop();\n    portfolioReconciliationWorker.stop();');
}

fs.writeFileSync('src/server/core/SystemBootstrap.ts', code);
