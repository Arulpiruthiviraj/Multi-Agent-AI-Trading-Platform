import { eventBus } from './src/server/core/EventBus';
import { db } from './src/server/db';
import { newsEngine } from './src/server/news/NewsEngine';
import { chiefTrader } from './src/server/services/ChiefTraderAgent';
import { riskAgent } from './src/server/services/RiskAgent';
import { oms } from './src/server/services/OrderManagement';
import { AIRouter } from './src/server/ai/AIRouter';

async function run() {
  await AIRouter.getInstance().initialize();
  // Ensure the singletons are instantiated
  chiefTrader;
  riskAgent;
  oms;
  
  console.log("Submitting mock news article to pipeline...");
  
  // We mock the AI provider to just return a valid JSON so we don't use real tokens
  AIRouter.getInstance().routeTask = async () => ({
    content: JSON.stringify({
      symbol: "NVDA",
      headline: "Nvidia announces record earnings",
      source: "Benzinga",
      timestamp: new Date().toISOString(),
      category: "Earnings",
      sentimentScore: 0.9,
      marketImpactScore: 95,
      confidence: 90,
      affectedSectors: ["Technology"],
      tradingBias: "BULLISH",
      reasoning: "Record earnings surprise indicates strong growth.",
      riskFlags: []
    }),
    provider: "mock",
    latency: 100
  });
  
  // Hook into events
  eventBus.on('TRADE_IDEA_GENERATED', (idea) => console.log('[TEST] Idea:', idea));
  eventBus.on('CHIEF_APPROVED_IDEA', (idea) => console.log('[TEST] Chief Approved:', idea));
  eventBus.on('RISK_ASSESSMENT_COMPLETED', (assessment) => console.log('[TEST] Risk Assessment:', assessment));
  eventBus.on('ORDER_EXECUTED', (order) => console.log('[TEST] Order Executed:', order));

  // Run the pipeline using a mock raw article
  const raw = {
    id: "test-123",
    title: "Nvidia announces record earnings",
    content: "Nvidia beat all expectations today...",
    source: "Test",
    author: "Test Author",
    publishedAt: new Date().toISOString(),
    url: "http://test.com",
    symbols: ["NVDA"]
  };
  
  const normalized = (newsEngine as any).normalizer.normalize(raw);
  const credibility = (newsEngine as any).credibilityEngine.assess(normalized, 0.8);
  const category = (newsEngine as any).classifier.classify(normalized);
  const impact = (newsEngine as any).impactEngine.assess(normalized, category);
  const clusterId = await (newsEngine as any).clusterEngine.createOrUpdateCluster(normalized, category, impact, credibility, ["NVDA"]);
  
  const aiAnalysis = await (newsEngine as any).scoringEngine.analyzeWithAI(normalized, "test-trace");
  
  if (aiAnalysis && aiAnalysis.tradingBias !== 'NEUTRAL') {
      eventBus.emitTradeIdea({ 
          traceId: "test-trace", 
          symbol: aiAnalysis.symbol, 
          side: aiAnalysis.tradingBias === 'BULLISH' ? 'BUY' : 'SELL', 
          confidence: (aiAnalysis.confidence / 100) * credibility,
          reasoning: `[News Intelligence] ${aiAnalysis.reasoning}`, 
          agent: "NewsAgent",
          newsDetails: {
              used: true,
              sentiment: aiAnalysis.sentimentScore || 0,
              confidence: aiAnalysis.confidence / 100,
              sources: normalized.source,
              reasoning: aiAnalysis.reasoning
          }
      });
  }
}
run();
