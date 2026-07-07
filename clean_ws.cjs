const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const danglingStart = '      }\n  });\n  \n  alpacaWs.on(\'close\', () => {\n    console.log(\'[Alpaca WS] Connection closed. Reconnecting in 5s...\');\n    setTimeout(initializeAlpacaWebSocket, 5000);\n  });\n  \n  alpacaWs.on(\'error\', (err) => {\n    console.error(\'[Alpaca WS] Error:\', err.message);\n  });\n}';
code = code.replace(danglingStart, '');

fs.writeFileSync('server.ts', code);
console.log("Dangling WS code removed.");
