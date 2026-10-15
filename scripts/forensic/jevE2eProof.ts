/**
 * ISOLATED end-to-end proof for Jev shadow scoring (2026-10-15).
 * Runs the REAL production code path - kickOffJevShadowScoring -> AICallGovernor -> JevProvider (real authenticated HTTP call) -> recordShadowScore -> getCalibrationSummary -
 * against a throwaway SQLite file. The only production touch is a read-only SELECT of one real, recent news article. Never prints the API key.
 * usage: npx tsx scripts/forensic/jevE2eProof.ts <productionDb(read-only)> <isolatedDbPath> <envFileWithJevKey>
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const [PROD_DB, ISO_DB, ENV_FILE] = process.argv.slice(2);
if (!PROD_DB || !ISO_DB || !ENV_FILE) throw new Error('usage: jevE2eProof.ts <productionDb> <isolatedDb> <envFile>');
for (const e of ['', '-wal', '-shm']) try { fs.unlinkSync(ISO_DB + e); } catch { /* none */ }

// --- environment for the isolated process (set BEFORE any server module is imported)
process.env.ARGUS_DB_PATH = ISO_DB;
process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = 'true';
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
  const m = /^(JEV_API_KEY|JEV_BASE_URL|TYPESAFE_API_KEY)=(.*)$/.exec(line);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) throw new Error('no Jev key available in the env file');

// --- one genuine, recent article (read-only, rowid-bounded)
const prod = new Database(PROD_DB, { readonly: true, timeout: 3000 });
prod.pragma('query_only=1');
const mx = (prod.prepare('select max(rowid) m from news_articles').get() as { m: number }).m;
const row = prod.prepare(
  `select a.title, a.content, a.url, a.source, a.author, a.published_at, a.symbols, a.credibility_score, c.impact_score, c.event_type, c.time_horizon, c.article_count
   from news_articles a left join news_clusters c on c.id = a.cluster_id
   where a.rowid > ? and length(a.content) > 200 and a.symbols is not null and a.symbols != '[]' order by a.rowid desc limit 1`,
).get(mx - 400) as Record<string, any> | undefined;
prod.close();
if (!row) throw new Error('no recent eligible article found');
let symbols: string[] = [];
try { symbols = JSON.parse(row.symbols); } catch { symbols = String(row.symbols).split(','); }
const symbol = String(symbols[0] || '').toUpperCase();
const article = {
  id: 'proof-' + crypto.createHash('sha1').update(row.title).digest('hex').slice(0, 10), title: row.title, content: row.content, url: row.url, source: row.source,
  author: row.author || '', publishedAt: row.published_at, symbols, fingerprint: crypto.createHash('sha1').update(row.title + row.published_at).digest('hex'),
};
const deterministic = {
  category: row.event_type || 'GENERAL', credibility: Math.min(1, Math.max(0, Number(row.credibility_score ?? 0.6))), isNewCluster: true,
  priorArticleCount: Math.max(0, Number(row.article_count ?? 1) - 1), impactScore01: Math.min(1, Math.max(0, Number(row.impact_score ?? 0.3) / (Number(row.impact_score ?? 0) > 1 ? 100 : 1))), timeHorizon: row.time_horizon || 'SHORT_TERM',
};

async function main() {
  const out: Record<string, unknown> = { input: { symbol, source: article.source, publishedAt: article.publishedAt, titleChars: article.title.length, bodyChars: article.content.length, deterministic } };
  const { kickOffJevShadowScoring } = await import('../../src/server/news/JevNewsTriage');
  const { getCalibrationSummary } = await import('../../src/server/news/JevShadowLedger');
  const { db } = await import('../../src/server/db');
  const { sql } = await import('drizzle-orm');
  const count = async () => Number(((await db.all(sql`select count(*) c from jev_shadow_scores`)) as any[])[0].c);
  const waitFor = async (n: number, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await count()) >= n) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };

  out.rowsBefore = await count();
  const t0 = Date.now();
  kickOffJevShadowScoring({ article: article as any, symbol, traceId: 'jev-proof-' + Date.now(), llmAnalysis: null, deterministic });
  out.firstCallRecorded = await waitFor(1, 60_000);
  out.firstCallWallMs = Date.now() - t0;
  out.rowsAfterFirst = await count();
  const rows = (await db.all(sql`select * from jev_shadow_scores order by rowid desc limit 1`)) as any[];
  out.firstRow = rows[0] ? Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '...' : v])) : null;

  // duplicate: same article fingerprint again
  kickOffJevShadowScoring({ article: article as any, symbol, traceId: 'jev-proof-dup-' + Date.now(), llmAnalysis: null, deterministic });
  await new Promise((r) => setTimeout(r, 8000));
  out.rowsAfterDuplicate = await count();

  // no-input: empty body must produce no request and no row
  kickOffJevShadowScoring({ article: { ...article, content: '', fingerprint: 'empty-' + Date.now() } as any, symbol, traceId: 'jev-proof-empty', llmAnalysis: null, deterministic });
  await new Promise((r) => setTimeout(r, 3000));
  out.rowsAfterNoInput = await count();

  out.calibrationSummary = await getCalibrationSummary();
  const { AICallGovernor } = await import('../../src/server/ai/AICallGovernor');
  try { out.governorSnapshot = (AICallGovernor.getInstance() as any).getSnapshot?.() ?? 'no getSnapshot'; } catch (e) { out.governorSnapshot = 'unavailable: ' + (e as Error).message; }
  fs.writeFileSync(ISO_DB + '.result.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}
main().catch((e) => { console.error('PROOF FAILED:', e?.message || e); process.exit(1); });
