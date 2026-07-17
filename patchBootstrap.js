import fs from 'fs';
let code = fs.readFileSync('src/server/core/SystemBootstrap.ts', 'utf8');

const importQuant = `import { advancedQuantEngines } from '../engines/AdvancedQuantEngines';\n`;

if (!code.includes('advancedQuantEngines')) {
  code = importQuant + code;
  code = code.replace('chiefTrader;', 'chiefTrader;\n    advancedQuantEngines.start();');
}

fs.writeFileSync('src/server/core/SystemBootstrap.ts', code);
