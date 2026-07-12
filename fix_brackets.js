import fs from 'fs';
let code = fs.readFileSync('src/App.tsx', 'utf8');
code = code.replace(/        \)\}\n        \{activeTab === "agents"/g, '{activeTab === "agents"');
fs.writeFileSync('src/App.tsx', code);
