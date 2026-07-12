import fs from 'fs';

let lines = fs.readFileSync('src/App.tsx', 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('Live Decision Flow Visualizer')) {
    // Look backwards for the wrapper
    for (let j = i; j >= i - 5; j--) {
      if (lines[j].includes('className="bg-[#111822] rounded-lg border border-slate-800 p-4 flex flex-col"')) {
        lines[j] = lines[j].replace('className="bg-[#111822] rounded-lg border border-slate-800 p-4 flex flex-col"', 'id="market-data-panel" className="bg-[#111822] rounded-lg border border-slate-800 p-4 flex flex-col"');
        break;
      }
    }
  }
}

fs.writeFileSync('src/App.tsx', lines.join('\n'));
console.log("Updated market ID");
