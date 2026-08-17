/**
 * Persist Mission Control idea-agent flags to settings.pipelineAgentEnabledJson.
 * Isolated from pipelineAgentGate.ts so idea agents can import the gate without opening SQLite.
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { applyPipelineAgentEnabledMap, getPipelineAgentEnabledMap } from './pipelineAgentGate';

export async function loadPipelineAgentEnabledFromDb(): Promise<void> {
  const rows = await db.select().from(schema.settings).limit(1);
  const raw = rows[0]?.pipelineAgentEnabledJson;
  if (!raw || raw === '{}') return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      applyPipelineAgentEnabledMap(parsed as Record<string, unknown>);
    }
  } catch (e) {
    console.error('[pipelineAgentPersist] Failed to parse settings.pipelineAgentEnabledJson - leaving defaults (all togglable idea agents on)', e);
  }
}

export async function persistPipelineAgentEnabled(): Promise<void> {
  const json = JSON.stringify(getPipelineAgentEnabledMap());
  await db.update(schema.settings).set({ pipelineAgentEnabledJson: json }).run();
}
