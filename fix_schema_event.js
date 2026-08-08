const fs = require('fs');
let code = fs.readFileSync('src/server/db/schema.ts', 'utf8');

code = code.replace(
/export const eventTraces = sqliteTable\('event_traces', \{[\s\S]*?\}\);/,
`export const eventTraces = sqliteTable('event_traces', {
  id: text('id').primaryKey(),
  correlationId: text('correlation_id'),
  tradeId: text('trade_id'),
  timestamp: integer('timestamp').notNull(),
  source: text('source').notNull(),
  destination: text('destination'),
  eventType: text('event_type').notNull(),
  payload: text('payload'), // JSON string
  durationMs: integer('duration_ms'),
  success: integer('success', { mode: 'boolean' }).default(true),
  errorInfo: text('error_info')
});`
);
fs.writeFileSync('src/server/db/schema.ts', code);
