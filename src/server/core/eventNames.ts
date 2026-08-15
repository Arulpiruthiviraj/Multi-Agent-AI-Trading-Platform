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

export const EVENTS = {
  POSITION_MONITORED: eventName('POSITION_MONITORED'),
  POSITION_RISK_CHANGED: eventName('POSITION_RISK_CHANGED'),
  PORTFOLIO_UPDATE: eventName('PORTFOLIO_UPDATE'),
  TRADE_IDEA_GENERATED: eventName('TRADE_IDEA_GENERATED'),
  AGENT_DISAGREEMENT: eventName('AGENT_DISAGREEMENT'),
  CHIEF_CONSENSUS_STARTED: eventName('CHIEF_CONSENSUS_STARTED'),
  CHIEF_CONSENSUS_COMPLETED: eventName('CHIEF_CONSENSUS_COMPLETED'),
} as const;
