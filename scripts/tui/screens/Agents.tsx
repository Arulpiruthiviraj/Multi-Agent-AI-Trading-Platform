/**
 * Agents screen: per-agent health, last assessment, direction, confidence.
 * Read-only; agents are observed, never driven, from the TUI.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { TuiApiClient, usePoll } from '../api.js';
import { Panel, DataTable, Badge } from '../components.js';
import { theme } from '../theme.js';

export function AgentsScreen({ client, refreshTick }: { client: TuiApiClient; refreshTick: number; compact: boolean }) {
  const agents = usePoll(client, (c) => c.agentHealth(), 5000, refreshTick);

  const list: any[] = Array.isArray((agents.data as any)?.agents)
    ? (agents.data as any).agents
    : Array.isArray(agents.data)
      ? (agents.data as any[])
      : [];

  return (
    <Box flexDirection="column">
      <Panel title={`AGENTS${list.length ? ` (${list.length})` : ''}`}>
        <DataTable
          columns={[
            { header: 'Agent', width: 16 },
            { header: 'Health', width: 12 },
            { header: 'Direction', width: 10 },
            { header: 'Conf', width: 8 },
            { header: 'Latency', width: 10 },
            { header: 'Errors', width: 8 },
          ]}
          emptyText={agents.data ? '(no agent data reported)' : '(loading…)'}
          rows={list.map((a) => {
            const healthy = (a.healthy ?? a.ok ?? a.status === 'healthy') || a.status === 'ok';
            return [
              <Text bold>{String(a.name ?? a.agent ?? '?')}</Text>,
              healthy ? <Badge tone="ok">HEALTHY</Badge> : <Badge tone="err">FAULT</Badge>,
              String(a.direction ?? a.lastDirection ?? '—'),
              a.confidence != null ? Number(a.confidence).toFixed(2) : '—',
              a.latencyMs != null ? `${a.latencyMs}ms` : '—',
              String(a.errors ?? a.errorCount ?? 0),
            ];
          })}
        />
        {agents.error && <Text color={theme.err}>{agents.error}</Text>}
        <Text color={theme.dim}>Agents run inside the engine. The TUI observes only.</Text>
      </Panel>
    </Box>
  );
}
