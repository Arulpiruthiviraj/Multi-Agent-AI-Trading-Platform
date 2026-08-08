const fs = require('fs');
const path = 'src/server/ai/AIRouter.ts';
let content = fs.readFileSync(path, 'utf8');

// The success: false inside the try block for successful routing needs to be true
content = content.replace(
  "latency, tokens: res ? res.tokens : 0, success: false",
  "latency, tokens: res ? res.tokens : 0, success: true"
);

fs.writeFileSync(path, content, 'utf8');
console.log('Patched AIRouter.ts success status');
