const fs = require('fs');
const path = 'src/server/db/index.ts';
let content = fs.readFileSync(path, 'utf8');

if (!content.includes('seedDefaultModels')) {
  content += "\nimport { seedDefaultModels } from './seedModels';\n";
  content += "seedDefaultModels().catch(console.error);\n";
  fs.writeFileSync(path, content, 'utf8');
  console.log('Patched db index.ts');
}
