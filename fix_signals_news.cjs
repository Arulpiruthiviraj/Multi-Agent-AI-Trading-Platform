const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetStr = `    const symbol = ((req.query.symbol as string) || "AAPL").toUpperCase();
    const sector = (req.query.sector as string) || "Technology";
    const newsHeadline =
      (req.query.headline as string) ||
      \`Technical consolidations push \${symbol} into high momentum buy zone.\`;`;

const replaceStr = `    const symbol = ((req.query.symbol as string) || "AAPL").toUpperCase();
    const sector = (req.query.sector as string) || "Technology";
    
    let newsHeadline = req.query.headline as string;
    if (!newsHeadline) {
       if (liveNews[symbol] && liveNews[symbol].length > 0) {
           newsHeadline = liveNews[symbol][0].headline;
       } else {
           newsHeadline = \`Technical consolidations push \${symbol} into high momentum buy zone.\`;
       }
    }`;

if (code.includes(targetStr)) {
  code = code.replace(targetStr, replaceStr);
  fs.writeFileSync('server.ts', code);
  console.log("Signals updated with live news fallback.");
} else {
  console.log("Could not find the target string.");
}
