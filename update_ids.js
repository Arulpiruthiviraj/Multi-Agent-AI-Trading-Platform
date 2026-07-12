import fs from 'fs';

let lines = fs.readFileSync('src/App.tsx', 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
  // Add ID to AgentTopologyMap wrapper
  if (lines[i].includes('<AgentTopologyMap flowAnimationEnabled={flowAnimationEnabled} />')) {
    // Look backwards for the wrapper div
    for (let j = i; j >= i - 10; j--) {
      if (lines[j].includes('className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5"')) {
        lines[j] = lines[j].replace('className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5"', 'id="agent-council-panel" className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5"');
        break;
      }
    }
  }

  // Add ID to GuardrailsPanel wrapper
  if (lines[i].includes('<GuardrailsPanel />')) {
    lines[i] = '             <div id="risk-guardrails-panel"><GuardrailsPanel /></div>';
  }
}

fs.writeFileSync('src/App.tsx', lines.join('\n'));
console.log("Updated IDs");
