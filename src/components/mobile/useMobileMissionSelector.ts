import { useSyncExternalStore } from 'react';
import {
  getMobileMissionSnapshot,
  subscribeMobileMissionSnapshot,
  type MobileMissionSnapshot,
} from './mobileMissionStore';

export function useMobileMissionSnapshot(): MobileMissionSnapshot {
  return useSyncExternalStore(subscribeMobileMissionSnapshot, getMobileMissionSnapshot, getMobileMissionSnapshot);
}

export function useMobileMissionSelector<T>(selector: (s: MobileMissionSnapshot) => T): T {
  return useSyncExternalStore(
    subscribeMobileMissionSnapshot,
    () => selector(getMobileMissionSnapshot()),
    () => selector(getMobileMissionSnapshot()),
  );
}
