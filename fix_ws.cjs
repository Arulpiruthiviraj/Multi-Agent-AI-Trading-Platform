const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const wsLogicMatch = code.match(/let liveQuotes = \{\};[\s\S]*?initializeAlpacaWebSocket\(\) \{[\s\S]*?\}\n/);

if (wsLogicMatch) {
  const wsLogic = wsLogicMatch[0];
  code = code.replace(wsLogic, '');
  // Insert right after the last import
  const importsEnd = code.lastIndexOf('import ') + code.substring(code.lastIndexOf('import ')).indexOf('\n') + 1;
  const beforeImports = code.substring(0, importsEnd);
  const afterImports = code.substring(importsEnd);
  
  code = beforeImports + "\n" + wsLogic.replace('let liveQuotes = {}', 'let liveQuotes: any = {}').replace('let alpacaWs = null;', 'let alpacaWs: any = null;') + afterImports;
}

// Ensure AUTOBOT_SYMBOLS is defined before initializeAlpacaWebSocket is CALLED, but it's used inside the WS message handler.
// The WS message handler uses AUTOBOT_SYMBOLS, so AUTOBOT_SYMBOLS must be hoisted or defined at the module level.
const symbolsTarget = 'const AUTOBOT_SYMBOLS = ["TSLA", "NVDA", "AAPL", "MSTR", "PLTR", "CRWD", "AMD", "SNOW", "META", "GOOG", "COIN"];';
if (code.includes(symbolsTarget)) {
  code = code.replace(symbolsTarget, '');
  const importEnd = code.lastIndexOf('import ') + code.substring(code.lastIndexOf('import ')).indexOf('\n') + 1;
  code = code.substring(0, importEnd) + "\n" + symbolsTarget + "\n" + code.substring(importEnd);
}

fs.writeFileSync('server.ts', code);
console.log("WebSocket logic fixed.");
