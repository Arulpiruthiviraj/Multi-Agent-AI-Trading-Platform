const fs = require('fs');
const path = 'src/server/services/ChiefTraderAgent.ts';
let content = fs.readFileSync(path, 'utf8');

// replace the end
content = content.replace(/export const chiefTrader = new ChiefTraderAgent\(\);\s*}/g, '}\nexport const chiefTrader = new ChiefTraderAgent();\n');

// verify we only have one at the end
if (!content.match(/}\nexport const chiefTrader = new ChiefTraderAgent\(\);\n$/)) {
    content = content.replace(/export const chiefTrader = new ChiefTraderAgent\(\);/g, '}\nexport const chiefTrader = new ChiefTraderAgent();\n');
}
fs.writeFileSync(path, content, 'utf8');
