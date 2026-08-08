const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');
code = code.replace(/uuidv4\(\)/g, "crypto.randomUUID()");
fs.writeFileSync('server.ts', code);
console.log("Fixed server.ts");
