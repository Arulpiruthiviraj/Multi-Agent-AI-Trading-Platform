const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

if (!code.includes('import WebSocket from "ws"')) {
  code = code.replace('import dotenv from "dotenv";', 'import dotenv from "dotenv";\nimport WebSocket from "ws";');
}

const wsLogic = `
let liveQuotes = {};
let alpacaWs = null;

function initializeAlpacaWebSocket() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return;
  const isPaper = process.env.PAPER_TRADING_ONLY !== "false";
  const wssUrl = "wss://stream.data.alpaca.markets/v2/iex"; // Real-time market data
  alpacaWs = new WebSocket(wssUrl);
  
  alpacaWs.on('open', () => {
    console.log('[Alpaca WS] Connected to market data stream.');
    alpacaWs.send(JSON.stringify({
      action: 'auth',
      key: process.env.ALPACA_API_KEY,
      secret: process.env.ALPACA_SECRET_KEY
    }));
  });
  
  alpacaWs.on('message', (data) => {
    const messages = JSON.parse(data.toString());
    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        console.log('[Alpaca WS] Authenticated successfully. Subscribing to quotes...');
        alpacaWs.send(JSON.stringify({
          action: 'subscribe',
          quotes: AUTOBOT_SYMBOLS
        }));
      } else if (msg.T === 'q') {
        liveQuotes[msg.S] = {
          bid: msg.bp,
          ask: msg.ap,
          price: (msg.bp + msg.ap) / 2
        };
      } else if (msg.T === 't') {
        if (!liveQuotes[msg.S]) liveQuotes[msg.S] = { bid: msg.p, ask: msg.p, price: msg.p };
        liveQuotes[msg.S].price = msg.p;
      }
    }
  });
  
  alpacaWs.on('close', () => {
    console.log('[Alpaca WS] Connection closed. Reconnecting in 5s...');
    setTimeout(initializeAlpacaWebSocket, 5000);
  });
  
  alpacaWs.on('error', (err) => {
    console.error('[Alpaca WS] Error:', err.message);
  });
}
`;

if (!code.includes('let liveQuotes = {}')) {
  // Insert before AUTOBOT_SYMBOLS
  code = code.replace('const AUTOBOT_SYMBOLS', wsLogic + '\nconst AUTOBOT_SYMBOLS');
}

const targetPrices = 'let currentPrice = closes[closes.length - 1];';
const replacePrices = `let currentPrice = closes[closes.length - 1];
  if (liveQuotes[symbol] && liveQuotes[symbol].price > 0) {
    currentPrice = liveQuotes[symbol].price;
    closes[closes.length - 1] = currentPrice;
  }`;

if (code.includes(targetPrices) && !code.includes('liveQuotes[symbol].price')) {
  code = code.replace(targetPrices, replacePrices);
}

if (!code.includes('initializeAlpacaWebSocket()') && code.includes('const app = express();')) {
  code = code.replace('const app = express();', 'const app = express();\n  initializeAlpacaWebSocket();');
}

fs.writeFileSync('server.ts', code);
console.log("WebSocket logic added.");
