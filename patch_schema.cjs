const fs = require('fs');
const path = 'src/server/db/schema.ts';
let content = fs.readFileSync(path, 'utf8');

// ai_providers table is mostly correct but needs display_name, created_at, updated_at
const aiProvidersReplacement = `
export const aiProviders = sqliteTable('ai_providers', {
  id: text('id').primaryKey(),
  providerName: text('provider_name').notNull(),
  displayName: text('display_name'),
  apiEndpoint: text('api_endpoint'),
  apiKeyEncrypted: text('api_key_encrypted'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  priority: integer('priority').default(1),
  active: integer('active', { mode: 'boolean' }).default(true),
  health: text('health').default('Healthy'),
  latency: real('latency').default(0),
  quota: real('quota').default(0),
  requests: integer('requests').default(0),
  tokens: integer('tokens').default(0),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  cost: real('cost').default(0),
  successRate: real('success_rate').default(100),
  lastFailure: text('last_failure'),
  lastSuccess: text('last_success'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at')
});
`;

content = content.replace(/export const aiProviders = sqliteTable\('ai_providers', \{[\s\S]*?\}\);/, aiProvidersReplacement.trim());

// ai_models table needs the requested fields
const aiModelsReplacement = `
export const aiModels = sqliteTable('ai_models', {
  id: text('id').primaryKey(),
  providerId: text('provider_id'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  displayName: text('display_name'),
  capabilities: text('capabilities'),
  predictedOhlc: text('predicted_ohlc'),
  marketStructure: text('market_structure'),
  momentum: text('momentum'),
  actualResult: text('actual_result'),
  mae: real('mae'),
  rmse: real('rmse'),
  mape: real('mape'),
  directionalAccuracy: real('directional_accuracy'),
  contextWindow: integer('context_window').default(8192),
  maxOutput: integer('max_output').default(4096),
  reasoningSupport: integer('reasoning_support', { mode: 'boolean' }).default(false),
  visionSupport: integer('vision_support', { mode: 'boolean' }).default(false),
  toolCalling: integer('tool_calling', { mode: 'boolean' }).default(false),
  structuredOutput: integer('structured_output', { mode: 'boolean' }).default(false),
  streaming: integer('streaming', { mode: 'boolean' }).default(true),
  pricingInput: real('pricing_input').default(0),
  pricingOutput: real('pricing_output').default(0),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  priority: integer('priority').default(1),
  latencyScore: real('latency_score').default(0),
  errorRate: real('error_rate').default(0),
  tokenUsage: integer('token_usage').default(0),
  estimatedCost: real('estimated_cost').default(0),
  lastUsedAt: text('last_used_at'),
  lastHealthCheck: text('last_health_check')
});
`;

content = content.replace(/export const aiModels = sqliteTable\('ai_models', \{[\s\S]*?\}\);/, aiModelsReplacement.trim());

fs.writeFileSync(path, content, 'utf8');
console.log('Patched schema.ts');
