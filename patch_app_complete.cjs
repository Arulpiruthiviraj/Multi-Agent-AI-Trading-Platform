const fs = require('fs');
const path = 'src/App.tsx';
let content = fs.readFileSync(path, 'utf8');

const replacement = `
      {!setupComplete && (
        <SetupWizard onSkip={() => setSetupComplete(true)} onComplete={async (config) => {
          // Save AI Providers
          if (config.aiProviders) {
            for (const [provider, data] of Object.entries(config.aiProviders)) {
              if (data.connected && data.key && data.key !== "mock") {
                try {
                  await fetch("/api/v1/config/providers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ provider, apiKey: data.key })
                  });
                } catch (e) { console.error("Failed to save provider:", provider, e); }
              }
            }
          }
          setAutoBotTargetBudget(config.initialCapital);
          setAutoBotRiskLevel(config.riskProfile);
          setAutoBotTradingMode(config.tradingMode);
          setAutoBotConfig({ ...autoBotConfig, enabled: true, budget: config.initialCapital, riskLevel: config.riskProfile, strategy: config.aiProvider });
          setSystemState('READY');
          setSetupComplete(true);
        }} />
      )}
`;

content = content.replace(/\{!setupComplete && \([\s\S]*?\}\} \/>\n      \)\}/, replacement.trim());

fs.writeFileSync(path, content, 'utf8');
console.log('Patched App.tsx onComplete');
