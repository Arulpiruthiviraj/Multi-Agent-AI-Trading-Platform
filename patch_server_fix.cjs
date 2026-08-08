const fs = require('fs');
const path = 'server.ts';
let content = fs.readFileSync(path, 'utf8');

const regex = /\}\n  \}\);\n  const results = await Promise\.all\(promises\);\n  return \{\n    consensus_verdict: "BUY", \/\/ Mock majority vote\n    latency_ms: Date\.now\(\) - start,\n    results\n  \};\n\}/;

content = content.replace(regex, '}');

fs.writeFileSync(path, content, 'utf8');
console.log('Fixed server.ts');
