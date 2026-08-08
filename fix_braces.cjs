const fs = require('fs');
const path = 'src/server/services/ChiefTraderAgent.ts';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(/}\nexport const chiefTrader = new ChiefTraderAgent\(\);\n}$/, '}\n}\nexport const chiefTrader = new ChiefTraderAgent();\n');
fs.writeFileSync(path, content, 'utf8');
