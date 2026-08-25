/**
 * Loads config/networkEndpoints.json. Centralized default network endpoints — broker REST hosts,
 * market-data/news provider bases, local/cloud AI runtime URLs. A reviewed config change, not a
 * UI/API knob.
 *
 * These are DEFAULTS, not the final word: callers that already have a real env-var override
 * (ALPACA_API_KEY-adjacent hosts don't have their own override, but IBKR_GATEWAY_URL,
 * OLLAMA_HOST, LOCAL_AI_SERVICE_URL, ALPACA_DATA_STREAM_URL, OPENALICE_MCP_URL do) must keep
 * checking that env var first and fall back to this file's value only when the env var is unset —
 * this module does not change that precedence, it only replaces the literal string that used to
 * be duplicated inline at each call site.
 *
 * Deliberately NOT sourced from here: OpenAliceVerificationService.ts's GUARDIAN_MCP_URL (a
 * safety-net constant that force-switches away from a misconfigured/malicious trading MCP — see
 * that file's own header for why it must stay a reviewed, non-operator-touchable literal) and
 * server.ts's own PORT/bindHost (security-relevant AUTH_ENABLED-gated bind logic).
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface NetworkEndpoints {
  broker: {
    alpaca: { paperBaseUrl: string; liveBaseUrl: string; dataBaseUrl: string; dataStreamUrl: string };
    ibkr: { gatewayUrlDefault: string; gatewayPortDefault: number };
    coinbase: { apiHost: string };
    questrade: { oauthTokenUrl: string };
  };
  marketData: {
    alphaVantageBaseUrl: string;
    finnhubBaseUrl: string;
    fmpBaseUrl: string;
    polygonBaseUrl: string;
  };
  newsRss: {
    userAgent: string;
    yahooFinance: string;
    cnbc: string;
    wsj: string;
  };
  aiLocal: {
    ollamaDefault: string;
    chronosDefault: string;
    guardianMcpUrl: string;
    liteLlmGatewayDefault: string;
  };
  aiCloud: {
    openAiChatCompletionsUrl: string;
    deepSeekChatCompletionsUrl: string;
    nvidiaBaseUrl: string;
    grokBaseUrl: string;
    openRouterBaseUrl: string;
    anthropicMessagesUrl: string;
    anthropicApiVersion: string;
  };
  ecosystem: {
    vibeTradingMcpPortDefault: number;
    guardianMcpPortDefault: number;
  };
}

function assertString(obj: any, path: string): void {
  const value = path.split('.').reduce((o, k) => o?.[k], obj);
  if (typeof value !== 'string' || !value) {
    throw new Error(`config/networkEndpoints.json missing string field: ${path}`);
  }
}

function assertNumber(obj: any, path: string): void {
  const value = path.split('.').reduce((o, k) => o?.[k], obj);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`config/networkEndpoints.json missing numeric field: ${path}`);
  }
}

const REQUIRED_STRINGS = [
  'broker.alpaca.paperBaseUrl', 'broker.alpaca.liveBaseUrl', 'broker.alpaca.dataBaseUrl', 'broker.alpaca.dataStreamUrl',
  'broker.ibkr.gatewayUrlDefault', 'broker.coinbase.apiHost', 'broker.questrade.oauthTokenUrl',
  'marketData.alphaVantageBaseUrl', 'marketData.finnhubBaseUrl', 'marketData.fmpBaseUrl', 'marketData.polygonBaseUrl',
  'newsRss.userAgent', 'newsRss.yahooFinance', 'newsRss.cnbc', 'newsRss.wsj',
  'aiLocal.ollamaDefault', 'aiLocal.chronosDefault', 'aiLocal.guardianMcpUrl', 'aiLocal.liteLlmGatewayDefault',
  'aiCloud.openAiChatCompletionsUrl', 'aiCloud.deepSeekChatCompletionsUrl', 'aiCloud.nvidiaBaseUrl',
  'aiCloud.grokBaseUrl', 'aiCloud.openRouterBaseUrl', 'aiCloud.anthropicMessagesUrl', 'aiCloud.anthropicApiVersion',
];
const REQUIRED_NUMBERS = ['broker.ibkr.gatewayPortDefault', 'ecosystem.vibeTradingMcpPortDefault', 'ecosystem.guardianMcpPortDefault'];

function loadNetworkEndpoints(): NetworkEndpoints {
  const raw = loadRepoConfigJson<NetworkEndpoints>('networkEndpoints.json');
  for (const path of REQUIRED_STRINGS) assertString(raw, path);
  for (const path of REQUIRED_NUMBERS) assertNumber(raw, path);
  return raw;
}

export const networkEndpoints: NetworkEndpoints = loadNetworkEndpoints();
