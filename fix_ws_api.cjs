const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(/alpacaWs\.on\('open',/g, 'alpacaWs.addEventListener("open",');
code = code.replace(/alpacaWs\.on\('message',/g, 'alpacaWs.addEventListener("message",');
code = code.replace(/alpacaWs\.on\('close',/g, 'alpacaWs.addEventListener("close",');
code = code.replace(/alpacaWs\.on\('error',/g, 'alpacaWs.addEventListener("error",');
// Also WHATWG message event data is in event.data
code = code.replace(/\(data\) => \{/g, '(event) => {');
code = code.replace(/const messages = JSON\.parse\(data\.toString\(\)\);/g, 'const messages = JSON.parse(event.data.toString());');

fs.writeFileSync('server.ts', code);
console.log("WebSocket API fixed.");
