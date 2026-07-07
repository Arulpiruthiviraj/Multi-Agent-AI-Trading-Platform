const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

// Find the start of initializeAlpacaWebSocket and everything down to `dotenv.config();`
const start = 'function initializeAlpacaWebSocket() {';
const end = 'dotenv.config();';

const regex = new RegExp('let liveQuotes: any = {};[\\s\\S]*?dotenv\\.config\\(\\);');

const newWsLogic = `let liveQuotes: any = {};
let alpacaWs: any = null;

function initializeAlpacaWebSocket() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return;
  const isPaper = process.env.PAPER_TRADING_ONLY !== "false";
  const wssUrl = "wss://stream.data.alpaca.markets/v2/iex";
  alpacaWs = new WebSocket(wssUrl);
  
  alpacaWs.addEventListener("open", () => {
    console.log('[Alpaca WS] Connected to market data stream.');
    alpacaWs.send(JSON.stringify({
      action: 'auth',
      key: process.env.ALPACA_API_KEY,
      secret: process.env.ALPACA_SECRET_KEY
    }));
  });
  
  alpacaWs.addEventListener("message", (event) => {
    const messages = JSON.parse(event.data.toString());
    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        console.log('[Alpaca WS] Authenticated successfully. Subscribing to quotes...');
        alpacaWs.send(JSON.stringify({
          action: 'subscribe',
          quotes: AUTOBOT_SYMBOLS
        }));
      } else if (msg.T === 'q') {
        liveQuotes[msg.S] = { bid: msg.bp, ask: msg.ap, price: (msg.bp + msg.ap) / 2 };
      } else if (msg.T === 't') {
        if (!liveQuotes[msg.S]) liveQuotes[msg.S] = { bid: msg.p, ask: msg.p, price: msg.p };
        liveQuotes[msg.S].price = msg.p;
      }
    }
  });
  
  alpacaWs.addEventListener("close", () => {
    console.log('[Alpaca WS] Connection closed. Reconnecting in 5s...');
    setTimeout(initializeAlpacaWebSocket, 5000);
  });
  
  alpacaWs.addEventListener("error", (err) => {
    console.error('[Alpaca WS] Error:', err.message);
  });
}

dotenv.config();`;

code = code.replace(regex, newWsLogic);

fs.writeFileSync('server.ts', code);
console.log("Replaced truncated initializeAlpacaWebSocket.");
