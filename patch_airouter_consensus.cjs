const fs = require('fs');
const path = 'src/server/ai/AIRouter.ts';
let content = fs.readFileSync(path, 'utf8');

const routeConsensusFunc = `
  public async routeConsensus(agentType: string, prompt: string, traceId: string): Promise<any> {
    let availableProviders = Array.from(this.providers.entries());
    
    // Fetch latest stats from DB to prioritize
    try {
        const dbStats = await db.select().from(schema.aiProviders);
        availableProviders = availableProviders.filter(([id, p]) => {
           const stat = dbStats.find(s => s.id === id);
           return !stat || stat.enabled;
        });
    } catch (e) {}
    
    if (availableProviders.length === 0) {
       throw new Error("No AI Providers available for consensus");
    }

    const start = Date.now();
    const promises = availableProviders.map(async ([providerId, provider]) => {
        const pStart = Date.now();
        try {
            if (!(await provider.authenticate())) {
                return { provider: providerId, status: "error", error: "Not authenticated", latency: 0 };
            }
            
            // Format prompt for consensus format
            const fullPrompt = prompt + "\\n\\nIMPORTANT: You must return a strict JSON object with this format (no markdown code blocks):\\n{\\n  \\"decision\\": \\"BUY\\" | \\"SELL\\" | \\"HOLD\\",\\n  \\"confidence\\": 0-100,\\n  \\"reasoning\\": \\"Detailed explanation...\\",\\n  \\"supportingFactors\\": [\\"fact1\\"],\\n  \\"risks\\": [\\"risk1\\"]\\n}";
            
            const res = await provider.chat(fullPrompt, { model: undefined });
            const latency = Date.now() - pStart;
            
            // Log usage
            try {
                eventBus.publish('UI_UPDATE', { type: 'ai_metrics_update', payload: {
                                provider: providerId, model: 'consensus', agent: agentType, latency, tokens: res.tokens, success: true
                            } });
                await db.insert(schema.aiUsage).values({
                    id: uuidv4(),
                    timestamp: new Date().toISOString(),
                    provider: providerId,
                    model: 'consensus',
                    agent: agentType,
                    promptTokens: 0,
                    completionTokens: res.tokens,
                    latency,
                    cost: provider.estimateCost(0, res.tokens),
                    responseStatus: 'success'
                });
            } catch (e) {}

            let parsed: any = {};
            try {
               let cleanText = res.content.trim();
               if (cleanText.startsWith('\`\`\`json')) cleanText = cleanText.substring(7);
               if (cleanText.startsWith('\`\`\`')) cleanText = cleanText.substring(3);
               if (cleanText.endsWith('\`\`\`')) cleanText = cleanText.substring(0, cleanText.length - 3);
               parsed = JSON.parse(cleanText.trim());
            } catch (e) {
               // Fallback parsing
               parsed = { decision: res.content.toUpperCase().includes("BUY") ? "BUY" : res.content.toUpperCase().includes("SELL") ? "SELL" : "HOLD", confidence: 50, reasoning: res.content, supportingFactors: [], risks: [] };
            }

            return {
                decision: parsed.decision || "HOLD",
                confidence: parsed.confidence || 0,
                reasoning: parsed.reasoning || res.content,
                supportingFactors: parsed.supportingFactors || [],
                risks: parsed.risks || [],
                model: 'default',
                provider: providerId,
                latencyMs: latency,
                tokenUsage: { input: 0, output: res.tokens },
                status: "success"
            };
        } catch(e:any) {
            // Log failure
            try {
                await db.insert(schema.aiUsage).values({
                    id: uuidv4(),
                    timestamp: new Date().toISOString(),
                    provider: providerId,
                    model: 'consensus',
                    agent: agentType,
                    promptTokens: 0,
                    completionTokens: 0,
                    latency: Date.now() - pStart,
                    cost: 0,
                    responseStatus: \`error: \${e.message}\`
                });
            } catch (err) {}
            return { provider: providerId, status: "error", error: e.message, latencyMs: Date.now() - pStart };
        }
    });

    const results = await Promise.all(promises);
    const successfulResults = results.filter(r => r.status === "success");
    
    // Determine overall verdict
    let buyWeight = 0;
    let sellWeight = 0;
    
    successfulResults.forEach(r => {
       if (r.decision === "BUY") buyWeight += r.confidence;
       if (r.decision === "SELL") sellWeight += r.confidence;
    });

    let verdict = "HOLD";
    if (buyWeight > sellWeight && buyWeight > 50) verdict = "BUY";
    if (sellWeight > buyWeight && sellWeight > 50) verdict = "SELL";

    return {
        consensus_verdict: verdict,
        latency_ms: Date.now() - start,
        results
    };
  }
`;

content = content.replace(/public async routeTask\(agentType: string, prompt: string, traceId: string\): Promise<\{content: string, provider: string, latency: number\}> \{/, routeConsensusFunc + '\n  public async routeTask(agentType: string, prompt: string, traceId: string): Promise<{content: string, provider: string, latency: number}> {');

fs.writeFileSync(path, content, 'utf8');
console.log('Patched AIRouter to add routeConsensus');
