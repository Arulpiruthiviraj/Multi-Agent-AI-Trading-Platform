const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

code = code.replace(/\/\/ --- New SQLite APIs as per prompt ---\s*\/\/ End New APIs[\s\S]*?\}\s*\}\);\s*/m, '// --- New SQLite APIs as per prompt ---\n  // End New APIs\n');
fs.writeFileSync('server.ts', code);
console.log('Fixed server.ts via regex.');
