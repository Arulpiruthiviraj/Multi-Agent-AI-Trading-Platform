const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

if (!code.includes('initializeAlpacaWebSocket();')) {
  code = code.replace('const app = express();', 'const app = express();\n  initializeAlpacaWebSocket();');
  fs.writeFileSync('server.ts', code);
  console.log("Called initializeAlpacaWebSocket.");
} else {
  console.log("Already called.");
}
