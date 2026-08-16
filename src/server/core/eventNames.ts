import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

interface EventNamesFile {
  persist: string[];
  [key: string]: string | string[];
}

const catalog = loadRepoConfigJson<EventNamesFile>('eventNames.json');

export const PERSISTED_EVENTS: string[] = catalog.persist;

export function eventName(key: string): string {
  const value = catalog[key];
  if (typeof value !== 'string') {
    throw new Error(`Unknown event name key: ${key}`);
  }
  return value;
}

const skip = new Set(['persist', '$comment']);
export const EVENTS: Record<string, string> = {};
for (const [k, v] of Object.entries(catalog)) {
  if (!skip.has(k) && typeof v === 'string') EVENTS[k] = v;
}
