const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const target = `  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });`;
const replacement = `  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url || '', \`http://\${request.headers.host}\`).pathname;
      if (pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else {
        // Let Vite handle HMR upgrade requests
        // If production and not /ws, we can destroy or ignore, but in dev Vite handles its own upgrade.
      }
    } catch (e) {
      // ignore
    }
  });`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('server.ts', code);
    console.log('Successfully updated WebSocket server to noServer mode.');
} else {
    console.log('Target not found in server.ts');
}
