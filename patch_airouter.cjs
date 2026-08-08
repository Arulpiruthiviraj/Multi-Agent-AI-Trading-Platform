const fs = require('fs');
const path = 'src/server/ai/AIRouter.ts';
let content = fs.readFileSync(path, 'utf8');

// Add import
content = content.replace("import { OpenAICompatibleProvider } from './providers/OpenAICompatibleProvider';", "import { OpenAICompatibleProvider } from './providers/OpenAICompatibleProvider';\nimport { NvidiaProvider } from './providers/NvidiaProvider';");

// Add instantiation
const instantiation = `
         } else if (nameLower.includes('openai') && !p.apiEndpoint && !nameLower.includes('compatible')) {
             providerInstance = new OpenAIProvider();
             await (providerInstance as OpenAIProvider).initialize(apiKey);
         } else if (nameLower.includes('nvidia')) {
             providerInstance = new NvidiaProvider();
             await (providerInstance as NvidiaProvider).initialize(apiKey);
         } else {
`;
content = content.replace(/} else if \(nameLower.includes\('openai'\) && !p\.apiEndpoint && !nameLower\.includes\('compatible'\)\) \{\s*providerInstance = new OpenAIProvider\(\);\s*await \(providerInstance as OpenAIProvider\)\.initialize\(apiKey\);\s*\} else \{/, instantiation);

fs.writeFileSync(path, content, 'utf8');
console.log('Patched AIRouter.ts');
