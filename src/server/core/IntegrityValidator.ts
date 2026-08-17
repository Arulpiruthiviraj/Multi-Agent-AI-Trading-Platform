/**
 * ==========================================================
 * Module: IntegrityValidator
 *
 * Purpose:
 * A real, minimal "does this actually hold together" check - not a mock, not a static claim.
 * Every check below either queries the real live SQLite file, calls a real singleton's real
 * method, or makes a real (short-timeout) network call to a real local service. Nothing here is
 * a hardcoded "OK". A check that can't determine a real answer reports UNKNOWN, never a
 * fabricated PASS.
 *
 * Deliberately scoped: this checks structural presence/reachability (tables exist, brokers
 * expose capabilities, providers are seeded, local services answer), not correctness of the
 * business logic inside them - that's what the unit/integration tests are for.
 * ==========================================================
 */
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { sqliteDb } from '../db';
import * as schema from '../db/schema';
import { BrokerManager } from '../../brokers/BrokerManager';
import { resolveLocalAiServiceUrl } from '../ai/preferIpv4Loopback';
import { newsEngine } from '../news/NewsEngine';
import { openAliceVerificationService } from '../integrations/openalice/OpenAliceVerificationService';

export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface IntegrityCheck {
  id: string;
  description: string;
  status: CheckStatus;
  detail: string;
}

export interface IntegrityReport {
  timestamp: string;
  checks: IntegrityCheck[];
  score: string; // "N/M" passed
  scorePct: number;
}

function checkSchemaTablesExist(): IntegrityCheck {
  const expected = Object.values(schema)
    .filter((v): v is any => typeof v === 'object' && v !== null && 'getSQL' in (v as any))
    .map((table) => {
      try { return getTableConfig(table).name; } catch { return null; }
    })
    .filter((name): name is string => !!name);

  const existingRows = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const existing = new Set(existingRows.map(r => r.name));
  const missing = expected.filter(name => !existing.has(name));

  return {
    id: 'schema_tables_exist',
    description: `Every table declared in schema.ts exists in the live SQLite file (${expected.length} expected)`,
    status: missing.length === 0 ? 'PASS' : 'FAIL',
    detail: missing.length === 0 ? `All ${expected.length} declared tables present.` : `Missing: ${missing.join(', ')}`,
  };
}

function checkBrokersExposeCapabilities(): IntegrityCheck {
  try {
    const brokers = BrokerManager.getInstance().getAvailableBrokers();
    if (brokers.length === 0) return { id: 'brokers_have_capabilities', description: 'Every registered broker exposes a real capabilities object', status: 'FAIL', detail: 'No brokers registered.' };
    const required = ['canPlaceOrders', 'paperTrading', 'liveTrading', 'usEquities', 'canadianEquities'] as const;
    const bad = brokers.filter(b => required.some(k => typeof (b.capabilities as any)[k] !== 'boolean'));
    return {
      id: 'brokers_have_capabilities',
      description: 'Every registered broker exposes a real capabilities object',
      status: bad.length === 0 ? 'PASS' : 'FAIL',
      detail: bad.length === 0 ? `${brokers.length} brokers, all with real capability flags.` : `Malformed capabilities: ${bad.map(b => b.id).join(', ')}`,
    };
  } catch (e: any) {
    return { id: 'brokers_have_capabilities', description: 'Every registered broker exposes a real capabilities object', status: 'UNKNOWN', detail: e.message };
  }
}

function checkAiProvidersSeeded(): IntegrityCheck {
  try {
    const count = (sqliteDb.prepare('SELECT COUNT(*) as c FROM ai_providers').get() as { c: number }).c;
    return {
      id: 'ai_providers_seeded',
      description: 'At least one AI provider row exists for AIRouter to load',
      status: count > 0 ? 'PASS' : 'FAIL',
      detail: `${count} provider row(s).`,
    };
  } catch (e: any) {
    return { id: 'ai_providers_seeded', description: 'At least one AI provider row exists for AIRouter to load', status: 'UNKNOWN', detail: e.message };
  }
}

function checkNewsProvidersRegistered(): IntegrityCheck {
  try {
    const providers = newsEngine.providerManager.getProviders();
    return {
      id: 'news_providers_registered',
      description: 'NewsProviderManager has real provider plugins registered',
      status: providers.length > 0 ? 'PASS' : 'FAIL',
      detail: `${providers.length} provider(s): ${providers.map((p: any) => p.name).join(', ')}`,
    };
  } catch (e: any) {
    return { id: 'news_providers_registered', description: 'NewsProviderManager has real provider plugins registered', status: 'UNKNOWN', detail: e.message };
  }
}

async function checkLocalAiServiceReachable(): Promise<IntegrityCheck> {
  const url = resolveLocalAiServiceUrl();
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { id: 'local_ai_service_reachable', description: 'The local Chronos/FinBERT inference service answers /health', status: 'FAIL', detail: `${url}/health returned ${res.status}` };
    const body = await res.json();
    return { id: 'local_ai_service_reachable', description: 'The local Chronos/FinBERT inference service answers /health', status: 'PASS', detail: JSON.stringify(body) };
  } catch (e: any) {
    // Genuinely unknown/optional, not a hard FAIL - this service is documented as optional
    // (npm run ai:serve) and its absence is already handled gracefully elsewhere.
    return { id: 'local_ai_service_reachable', description: 'The local Chronos/FinBERT inference service answers /health', status: 'UNKNOWN', detail: `Not reachable at ${url}: ${e.message}` };
  }
}

async function checkOpenAliceReachable(): Promise<IntegrityCheck> {
  const id = 'openalice_reachable';
  const description = 'The optional OpenAlice external verification MCP server answers (only scored when enabled)';
  if (!openAliceVerificationService.enabled) {
    return { id, description, status: 'UNKNOWN', detail: 'OpenAlice integration disabled (OPENALICE_ENABLED != true) - this is the documented default, not a failure.' };
  }
  try {
    const health = await openAliceVerificationService.health();
    return {
      id,
      description,
      status: health.reachable ? 'PASS' : 'FAIL',
      detail: health.detail,
    };
  } catch (e: any) {
    return { id, description, status: 'UNKNOWN', detail: e.message };
  }
}

export async function runIntegrityCheck(): Promise<IntegrityReport> {
  const checks: IntegrityCheck[] = [
    checkSchemaTablesExist(),
    checkBrokersExposeCapabilities(),
    checkAiProvidersSeeded(),
    checkNewsProvidersRegistered(),
    await checkLocalAiServiceReachable(),
    await checkOpenAliceReachable(),
  ];

  const scored = checks.filter(c => c.status !== 'UNKNOWN');
  const passed = scored.filter(c => c.status === 'PASS').length;

  return {
    timestamp: new Date().toISOString(),
    checks,
    score: `${passed}/${scored.length}`,
    scorePct: scored.length > 0 ? Math.round((passed / scored.length) * 100) : 0,
  };
}
