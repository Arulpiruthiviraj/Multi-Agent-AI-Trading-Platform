const fs = require('fs');
let code = fs.readFileSync('src/components/AlpacaNewsTicker.tsx', 'utf8');

code = code.replace('const interval = setInterval(fetchAlpacaNews, 120000); // refresh every 2 mins', 'const interval = setInterval(fetchAlpacaNews, 5000); // Refresh frequently for WebSocket prioritization');

fs.writeFileSync('src/components/AlpacaNewsTicker.tsx', code);
console.log("Ticker polling updated.");
