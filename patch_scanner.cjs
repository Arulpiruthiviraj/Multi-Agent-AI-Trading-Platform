const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

const regex = /{activeTab === "scanner" && \([\s\S]*?<\/[dD]iv>\s*<\/[dD]iv>\s*\)}/;
const replacement = `{activeTab === "scanner" && (
          <StrategyScanner 
            assetPrices={assetPrices}
            selectedAlertSymbol={selectedAlertSymbol}
            setSelectedAlertSymbol={setSelectedAlertSymbol}
          />
        )}`;

if (regex.test(content)) {
  content = content.replace(regex, replacement);
  fs.writeFileSync('src/App.tsx', content);
  console.log("Patched successfully");
} else {
  console.log("Could not find the target block");
}
