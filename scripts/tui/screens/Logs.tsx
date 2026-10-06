/**
 * Logs screen: scrolling live event view from the existing observability
 * events API (bounded, paginated). Never tails raw files.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { TuiApiClient, usePoll } from '../api.js';
import { Panel, Badge } from '../components.js';
import { theme } from '../theme.js';

type Sev = 'ok' | 'warn' | 'err' | 'dim' | 'info';

function sevTone(e: any): Sev {
  const s = String(e.severity ?? e.level ?? '').toLowerCase();
  if (/error|fatal|crit/.test(s)) return 'err';
  if (/warn/.test(s)) return 'warn';
  if (/info|debug/.test(s)) return 'info';
  return 'dim';
}

export function LogsScreen({ client, refreshTick }: { client: TuiApiClient; refreshTick: number; compact: boolean }) {
  const events = usePoll(client, (c) => c.events(), 3000, refreshTick);

  const list: any[] = Array.isArray((events.data as any)?.events)
    ? (events.data as any).events
    : Array.isArray(events.data)
      ? (events.data as any[])
      : [];

  return (
    <Box flexDirection="column">
      <Panel title={`EVENT STREAM${list.length ? ` (latest ${list.length})` : ''}`}>
        {events.error && <Text color={theme.err}>{events.error}</Text>}
        {!events.data && !events.error && <Text color={theme.dim}>(loading…)</Text>}
        {events.data && list.length === 0 && <Text color={theme.dim}>(no events reported)</Text>}
        {list.slice(0, 30).map((e, i) => {
          const ts = e.ts ?? e.timestamp ?? e.time;
          const when = ts ? new Date(ts).toLocaleTimeString('en-US', { hour12: false }) : '--:--:--';
          return (
            <Box key={i}>
              <Box width={10} flexShrink={0}><Text color={theme.dim}>{when}</Text></Box>
              <Box width={8} flexShrink={0}><Badge tone={sevTone(e)}>{String(e.severity ?? e.level ?? 'INFO').slice(0, 5).toUpperCase()}</Badge></Box>
              <Box width={18} flexShrink={0}><Text color={theme.info} wrap="truncate">{String(e.component ?? e.source ?? '—')}</Text></Box>
              <Text wrap="truncate">{String(e.message ?? e.event ?? e.type ?? '—')}</Text>
            </Box>
          );
        })}
        <Text color={theme.dim}>Bounded to the latest 50 events per poll. r refreshes.</Text>
      </Panel>
    </Box>
  );
}
