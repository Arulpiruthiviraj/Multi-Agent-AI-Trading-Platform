const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

// The dangling part is:
//       }
//   });
//   
//   alpacaWs.on('close', () => {

code = code.replace(/      \}\n  \}\);\n  \n  alpacaWs\.on\('close', \(\) => \{[\s\S]*?\}\);/g, '');

fs.writeFileSync('server.ts', code);
console.log("Fixed dangling syntax.");
