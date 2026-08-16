/**
 * Persist operator-supplied API keys to SQLite via EncryptionService.
 * Never writes data/secrets.json.
 */

import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import * as schema from '../db/schema';
import { EncryptionService } from './EncryptionService';

export const SECRET_SPECS = [
  { key: 'ALPACA_API_KEY', label: 'Alpaca API Key', category: 'Broker' },
  { key: 'ALPACA_SECRET_KEY', label: 'Alpaca Secret Key', category: 'Broker' },
  { key: 'QUESTRADE_REFRESH_TOKEN', label: 'Questrade Token', category: 'Broker' },
  { key: 'QUESTRADE_ACCOUNT_ID', label: 'Questrade Account', category: 'Broker' },
  { key: 'GEMINI_API_KEY', label: 'Gemini Key', category: 'LLM' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI Key', category: 'LLM' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic Key', category: 'LLM' },
  { key: 'MISTRAL_API_KEY', label: 'Mistral Key', category: 'LLM' },
  { key: 'FRED_API_KEY', label: 'FRED Key', category: 'Market Data' },
  { key: 'FINNHUB_API_KEY', label: 'Finnhub Key', category: 'Market Data' },
] as const;

export const SECRET_ALLOWLIST = new Set<string>(SECRET_SPECS.map((s) => s.key));

const ALPACA_BROKER_NAME = 'Alpaca';
const QUESTRADE_BROKER_NAME = 'Questrade (Canada)';

async function upsertBrokerPair(
  brokerName: string,
  apiKey?: string,
  secret?: string,
  accountId?: string,
): Promise<void> {
  const existing = await db.select().from(schema.brokerConnections)
    .where(eq(schema.brokerConnections.brokerName, brokerName));
  const patch: Record<string, unknown> = {};
  if (apiKey) patch.apiKeyEncrypted = EncryptionService.encrypt(apiKey);
  if (secret) patch.secretEncrypted = EncryptionService.encrypt(secret);
  if (accountId) patch.accountId = accountId;
  if (Object.keys(patch).length === 0) return;
  if (existing.length > 0) {
    await db.update(schema.brokerConnections).set(patch)
      .where(eq(schema.brokerConnections.id, existing[0].id));
  } else {
    await db.insert(schema.brokerConnections).values({
      brokerName,
      paperMode: true,
      apiKeyEncrypted: (patch.apiKeyEncrypted as string) ?? null,
      secretEncrypted: (patch.secretEncrypted as string) ?? null,
      accountId: (patch.accountId as string) ?? null,
    });
  }
}

async function upsertAiProvider(providerName: string, apiKey: string): Promise<void> {
  const existing = await db.select().from(schema.aiProviders)
    .where(eq(schema.aiProviders.providerName, providerName));
  const encrypted = EncryptionService.encrypt(apiKey);
  if (existing.length > 0) {
    await db.update(schema.aiProviders).set({ apiKeyEncrypted: encrypted, enabled: true })
      .where(eq(schema.aiProviders.id, existing[0].id));
  } else {
    await db.insert(schema.aiProviders).values({
      id: uuidv4(),
      providerName,
      displayName: providerName,
      apiKeyEncrypted: encrypted,
      enabled: true,
    });
  }
}

async function upsertNewsProvider(name: string, type: string, apiKey: string): Promise<void> {
  const existing = await db.select().from(schema.newsProviders)
    .where(eq(schema.newsProviders.name, name));
  const encrypted = EncryptionService.encrypt(apiKey);
  if (existing.length > 0) {
    await db.update(schema.newsProviders).set({ apiKeyEncrypted: encrypted, enabled: true })
      .where(eq(schema.newsProviders.id, existing[0].id));
  } else {
    await db.insert(schema.newsProviders).values({
      id: uuidv4(),
      name,
      type,
      apiKeyEncrypted: encrypted,
      enabled: true,
    });
  }
}

/** Writes allowlisted keys to SQLite (encrypted). Also sets process.env for this process only. */
export async function persistAllowlistedSecrets(values: Record<string, unknown>): Promise<string[]> {
  const applied: string[] = [];
  const get = (k: string) => {
    const v = values[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  const alpacaKey = get('ALPACA_API_KEY');
  const alpacaSecret = get('ALPACA_SECRET_KEY');
  if (alpacaKey || alpacaSecret) {
    await upsertBrokerPair(ALPACA_BROKER_NAME, alpacaKey, alpacaSecret);
    if (alpacaKey) { process.env.ALPACA_API_KEY = alpacaKey; applied.push('ALPACA_API_KEY'); }
    if (alpacaSecret) {
      process.env.ALPACA_SECRET_KEY = alpacaSecret;
      process.env.ALPACA_API_SECRET = alpacaSecret;
      applied.push('ALPACA_SECRET_KEY');
    }
  }

  const qtToken = get('QUESTRADE_REFRESH_TOKEN');
  const qtAccount = get('QUESTRADE_ACCOUNT_ID');
  if (qtToken || qtAccount) {
    await upsertBrokerPair(QUESTRADE_BROKER_NAME, qtToken, undefined, qtAccount);
    if (qtToken) { process.env.QUESTRADE_REFRESH_TOKEN = qtToken; applied.push('QUESTRADE_REFRESH_TOKEN'); }
    if (qtAccount) { process.env.QUESTRADE_ACCOUNT_ID = qtAccount; applied.push('QUESTRADE_ACCOUNT_ID'); }
  }

  const llm: Array<[string, string]> = [
    ['GEMINI_API_KEY', 'Gemini'],
    ['OPENAI_API_KEY', 'OpenAI'],
    ['ANTHROPIC_API_KEY', 'Anthropic'],
    ['MISTRAL_API_KEY', 'Mistral'],
  ];
  for (const [envKey, providerName] of llm) {
    const v = get(envKey);
    if (!v) continue;
    await upsertAiProvider(providerName, v);
    process.env[envKey] = v;
    applied.push(envKey);
  }

  const finnhub = get('FINNHUB_API_KEY');
  if (finnhub) {
    await upsertNewsProvider('Finnhub', 'api', finnhub);
    process.env.FINNHUB_API_KEY = finnhub;
    applied.push('FINNHUB_API_KEY');
  }
  const fred = get('FRED_API_KEY');
  if (fred) {
    await upsertNewsProvider('FRED', 'api', fred);
    process.env.FRED_API_KEY = fred;
    applied.push('FRED_API_KEY');
  }

  return applied;
}

export async function secretsStatusFromEnvAndDb(): Promise<Array<{
  key: string;
  label: string;
  category: string;
  configured: boolean;
  masked: string;
  source: 'env' | 'database' | 'unset';
}>> {
  const brokers = await db.select().from(schema.brokerConnections);
  const providers = await db.select().from(schema.aiProviders);
  const news = await db.select().from(schema.newsProviders);

  const hasBroker = (name: string, field: 'apiKeyEncrypted' | 'secretEncrypted') =>
    brokers.some((b) => b.brokerName === name && !!(b as any)[field]);
  const hasAi = (name: string) =>
    providers.some((p) => p.providerName.toLowerCase() === name.toLowerCase() && !!p.apiKeyEncrypted);
  const hasNews = (name: string) =>
    news.some((n) => n.name.toLowerCase() === name.toLowerCase() && !!n.apiKeyEncrypted);

  const dbConfigured: Record<string, boolean> = {
    ALPACA_API_KEY: hasBroker(ALPACA_BROKER_NAME, 'apiKeyEncrypted'),
    ALPACA_SECRET_KEY: hasBroker(ALPACA_BROKER_NAME, 'secretEncrypted'),
    QUESTRADE_REFRESH_TOKEN: hasBroker(QUESTRADE_BROKER_NAME, 'apiKeyEncrypted'),
    QUESTRADE_ACCOUNT_ID: brokers.some((b) => b.brokerName === QUESTRADE_BROKER_NAME && !!b.accountId),
    GEMINI_API_KEY: hasAi('Gemini'),
    OPENAI_API_KEY: hasAi('OpenAI'),
    ANTHROPIC_API_KEY: hasAi('Anthropic'),
    MISTRAL_API_KEY: hasAi('Mistral'),
    FRED_API_KEY: hasNews('FRED'),
    FINNHUB_API_KEY: hasNews('Finnhub'),
  };

  return SECRET_SPECS.map((spec) => {
    const envVal = process.env[spec.key];
    const fromEnv = !!envVal;
    const fromDb = !!dbConfigured[spec.key];
    const configured = fromEnv || fromDb;
    const source: 'env' | 'database' | 'unset' = fromEnv ? 'env' : fromDb ? 'database' : 'unset';
    return {
      key: spec.key,
      label: spec.label,
      category: spec.category,
      configured,
      masked: envVal ? '••••' + envVal.slice(-4) : (fromDb ? '•••• (database)' : ''),
      source,
    };
  });
}
