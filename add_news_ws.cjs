const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const wsLogic = `let liveQuotes: any = {};
let liveNews: any = {};
let alpacaWs: any = null;
let alpacaNewsWs: any = null;

function initializeAlpacaWebSocket() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return;
  const isPaper = process.env.PAPER_TRADING_ONLY !== "false";
  
  // Quotes WebSocket
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
    setTimeout(() => {
       if (alpacaWs) alpacaWs.close();
       initializeAlpacaWebSocket();
    }, 5000);
  });
  
  alpacaWs.addEventListener("error", (err) => {
    console.error('[Alpaca WS] Error:', err.message);
  });

  // News WebSocket
  const newsWssUrl = "wss://stream.data.alpaca.markets/v1beta1/news";
  alpacaNewsWs = new WebSocket(newsWssUrl);
  
  alpacaNewsWs.addEventListener("open", () => {
    console.log('[Alpaca News WS] Connected to news stream.');
    alpacaNewsWs.send(JSON.stringify({
      action: 'auth',
      key: process.env.ALPACA_API_KEY,
      secret: process.env.ALPACA_SECRET_KEY
    }));
  });
  
  alpacaNewsWs.addEventListener("message", (event) => {
    const messages = JSON.parse(event.data.toString());
    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        console.log('[Alpaca News WS] Authenticated successfully. Subscribing to news...');
        alpacaNewsWs.send(JSON.stringify({
          action: 'subscribe',
          news: ["*"] // Subscribe to all news
        }));
      } else if (msg.T === 'n') {
        // Store latest news by symbol
        for (const symbol of msg.symbols) {
           if (!liveNews[symbol]) liveNews[symbol] = [];
           liveNews[symbol].unshift(msg);
           // Keep only last 5
           if (liveNews[symbol].length > 5) {
             liveNews[symbol].pop();
           }
        }
      }
    }
  });
  
  alpacaNewsWs.addEventListener("close", () => {
    console.log('[Alpaca News WS] Connection closed.');
  });
  
  alpacaNewsWs.addEventListener("error", (err) => {
    console.error('[Alpaca News WS] Error:', err.message);
  });
}`;

const oldWsLogicRegex = /let liveQuotes: any = \{\};[\s\S]*?alpacaWs\.addEventListener\("error", \(err\) => \{[\s\S]*?console\.error\('\[Alpaca WS\] Error:', err\.message\);\n  \}\);\n\}/;

if (code.match(oldWsLogicRegex)) {
   code = code.replace(oldWsLogicRegex, wsLogic);
   fs.writeFileSync('server.ts', code);
   console.log("Replaced WS logic with News WS logic included");
} else {
   console.log("Could not find the old WS logic to replace");
}
