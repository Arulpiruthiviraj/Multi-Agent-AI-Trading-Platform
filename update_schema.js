const fs = require('fs');
let code = fs.readFileSync('src/server/db/schema.ts', 'utf8');

// Replace aiProviders with the new tables
code = code.replace(/export const aiProviders = sqliteTable\('ai_providers', \{[\s\S]*?\}\);/m, 
`export const aiProviders = sqliteTable('ai_providers', {
  id: text('id').primaryKey(),
  providerName: text('provider_name').notNull(),
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
  lastSuccess: text('last_success')
});

export const aiModels = sqliteTable('ai_models', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  contextWindow: integer('context_window').default(8192),
  maxOutput: integer('max_output').default(4096),
  reasoningSupport: integer('reasoning_support', { mode: 'boolean' }).default(false),
  visionSupport: integer('vision_support', { mode: 'boolean' }).default(false),
  toolCalling: integer('tool_calling', { mode: 'boolean' }).default(false),
  structuredOutput: integer('structured_output', { mode: 'boolean' }).default(false),
  streaming: integer('streaming', { mode: 'boolean' }).default(true),
  pricingInput: real('pricing_input').default(0),
  pricingOutput: real('pricing_output').default(0),
  enabled: integer('enabled', { mode: 'boolean' }).default(true)
});

export const aiUsage = sqliteTable('ai_usage', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  agent: text('agent'),
  promptTokens: integer('prompt_tokens').default(0),
  completionTokens: integer('completion_tokens').default(0),
  latency: real('latency').default(0),
  cost: real('cost').default(0),
  responseStatus: text('response_status'),
  retryCount: integer('retry_count').default(0)
});`);

fs.writeFileSync('src/server/db/schema.ts', code);
