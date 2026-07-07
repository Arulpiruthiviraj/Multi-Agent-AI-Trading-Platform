const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace('import WebSocket from "ws";', '');
code = code.replace('// @ts-ignore', '');

fs.writeFileSync('server.ts', code);
console.log("WebSocket import removed.");
