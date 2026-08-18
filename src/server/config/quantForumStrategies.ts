/**
 * Maps forum playbooks (r/RealDayTrading, r/Daytrading, thetagang, etc.) onto Argus
 * Quant modules or honest NOT_SUPPORTED. Catalog only — not a live enablement switch.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { CORE_STRATEGIES, EXPERIMENTAL_STRATEGIES } from '../quant/strategies/StrategyEngine';

export type ForumStrategyStatus = 'CORE' | 'EXPERIMENTAL' | 'NOT_SUPPORTED';

export interface ForumStrategyRow {
  id: string;
  forumName: string;
  forum: string;
  typicalAssets: string;
  status: ForumStrategyStatus;
  moduleId?: string;
  relatedModuleIds?: string[];
  honesty?: string;
  reason?: string;
}

export interface QuantForumStrategiesConfig {
  riskNote: string;
  strategies: ForumStrategyRow[];
}

const STATUSES = new Set<ForumStrategyStatus>(['CORE', 'EXPERIMENTAL', 'NOT_SUPPORTED']);

function loadForumStrategies(): QuantForumStrategiesConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('quantForumStrategies.json');
  if (typeof raw.riskNote !== 'string' || !raw.riskNote) {
    throw new Error('config/quantForumStrategies.json missing riskNote');
  }
  if (!Array.isArray(raw.strategies) || raw.strategies.length === 0) {
    throw new Error('config/quantForumStrategies.json missing strategies[]');
  }
  const known = new Set([...CORE_STRATEGIES, ...EXPERIMENTAL_STRATEGIES].map(s => s.id));
  const strategies: ForumStrategyRow[] = [];
  for (const item of raw.strategies) {
    if (!item || typeof item !== 'object') {
      throw new Error('config/quantForumStrategies.json strategies[] entry is not an object');
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) {
      throw new Error('config/quantForumStrategies.json strategy missing id');
    }
    if (typeof row.forumName !== 'string' || !row.forumName) {
      throw new Error(`config/quantForumStrategies.json ${row.id} missing forumName`);
    }
    if (typeof row.forum !== 'string' || !row.forum) {
      throw new Error(`config/quantForumStrategies.json ${row.id} missing forum`);
    }
    if (typeof row.typicalAssets !== 'string' || !row.typicalAssets) {
      throw new Error(`config/quantForumStrategies.json ${row.id} missing typicalAssets`);
    }
    if (typeof row.status !== 'string' || !STATUSES.has(row.status as ForumStrategyStatus)) {
      throw new Error(`config/quantForumStrategies.json ${row.id} invalid status`);
    }
    const status = row.status as ForumStrategyStatus;
    if (status === 'NOT_SUPPORTED') {
      if (typeof row.reason !== 'string' || !row.reason) {
        throw new Error(`config/quantForumStrategies.json ${row.id} NOT_SUPPORTED missing reason`);
      }
      strategies.push({
        id: row.id,
        forumName: row.forumName,
        forum: row.forum,
        typicalAssets: row.typicalAssets,
        status,
        reason: row.reason,
      });
      continue;
    }
    if (typeof row.moduleId !== 'string' || !row.moduleId) {
      throw new Error(`config/quantForumStrategies.json ${row.id} missing moduleId`);
    }
    if (!known.has(row.moduleId)) {
      throw new Error(`config/quantForumStrategies.json ${row.id} moduleId ${row.moduleId} is not a coded strategy`);
    }
    if (typeof row.honesty !== 'string' || !row.honesty) {
      throw new Error(`config/quantForumStrategies.json ${row.id} missing honesty`);
    }
    const related = Array.isArray(row.relatedModuleIds)
      ? row.relatedModuleIds.filter((x): x is string => typeof x === 'string' && known.has(x))
      : undefined;
    strategies.push({
      id: row.id,
      forumName: row.forumName,
      forum: row.forum,
      typicalAssets: row.typicalAssets,
      status,
      moduleId: row.moduleId,
      relatedModuleIds: related,
      honesty: row.honesty,
    });
  }
  return { riskNote: raw.riskNote, strategies };
}

export const quantForumStrategies: QuantForumStrategiesConfig = loadForumStrategies();
