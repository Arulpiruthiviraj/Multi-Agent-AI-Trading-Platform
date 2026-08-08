const fs = require('fs');
const path = 'server.ts';
let content = fs.readFileSync(path, 'utf8');

const regex = /async function callLLMConsensus\(prompt: string\) \{[\s\S]*?\}\n\}/;
const replacement = `async function callLLMConsensus(prompt: string) {
  try {
     return await AIRouter.getInstance().routeConsensus("ConsensusDebate", prompt, uuidv4());
  } catch (e: any) {
     return {
        consensus_verdict: "HOLD",
        latency_ms: 0,
        results: [{ provider: "mock", status: "error", error: e.message, latencyMs: 0 }]
     };
  }
}`;

content = content.replace(regex, replacement);

fs.writeFileSync(path, content, 'utf8');
console.log('Fixed server.ts');
