import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

const importWs = `import { WebSocketServer } from 'ws';
import { eventBus } from './src/server/core/EventBus';
`;

if (!code.includes('import { WebSocketServer }')) {
  code = importWs + code;
}

const wssSnippet = `
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    
    const onEvent = (eventName) => (data) => {
       if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: eventName, data }));
       }
    };
    
    const handlers = [
      { name: 'TRADE_IDEA_GENERATED', fn: onEvent('TRADE_IDEA_GENERATED') },
      { name: 'CHIEF_APPROVED_IDEA', fn: onEvent('CHIEF_APPROVED_IDEA') },
      { name: 'RISK_ASSESSMENT_COMPLETED', fn: onEvent('RISK_ASSESSMENT_COMPLETED') },
      { name: 'ORDER_EXECUTED', fn: onEvent('ORDER_EXECUTED') },
      { name: 'LEARNED_NEW_RULE', fn: onEvent('LEARNED_NEW_RULE') },
      { name: 'MARKET_DATA', fn: onEvent('MARKET_DATA') }
    ];

    handlers.forEach(h => eventBus.on(h.name, h.fn));

    ws.on('close', () => {
       handlers.forEach(h => eventBus.off(h.name, h.fn));
    });
  });
`;

code = code.replace(/httpServer\.listen\(PORT, "0\.0\.0\.0", \(\) => {/g, wssSnippet + '\n  httpServer.listen(PORT, "0.0.0.0", () => {');

fs.writeFileSync('server.ts', code);
