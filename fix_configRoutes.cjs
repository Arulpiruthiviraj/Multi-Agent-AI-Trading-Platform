const fs = require('fs');
let code = fs.readFileSync('src/server/routes/configRoutes.ts', 'utf8');
code = "import { AIRouter } from '../ai/AIRouter';\n" + code;
fs.writeFileSync('src/server/routes/configRoutes.ts', code);
console.log("Fixed configRoutes.ts");
