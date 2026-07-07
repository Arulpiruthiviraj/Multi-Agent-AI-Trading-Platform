const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

if (!code.includes('import WebSocket from "ws";')) {
  code = code.replace('import dotenv from "dotenv";', 'import dotenv from "dotenv";\nimport WebSocket from "ws";');
  fs.writeFileSync('server.ts', code);
  console.log("WebSocket imported.");
} else {
  console.log("WebSocket already imported.");
}
