/**
 * Consensus screen: recent consensus rounds with decision and reason.
 * Read-only.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { TuiApiClient, usePoll } from '../api.js';
import { Panel, DataTable, Badge } from '../components.js';
import { theme } from '../theme.js';

export function ConsensusScreen({ client, refreshTick }: { client: TuiApiClient; refreshTick: number; compact: boolean }) {
  const consensus = usePoll(client, (c) => c.consensus(), 5000, refreshTick);

  const rounds: any[] = Array.isArray((consensus.data as any)?.rounds)
    ? (consensus.data as any).rounds
    : Array.isArray(consensus.data)
      ? (consensus.data as any[])
      : [];

  return (
    <Box flexDirection="column">
      <Panel title={`CONSENSUS ROUNDS${rounds.length ? ` (${rounds.length})` : ''}`}>
        <DataTable
          columns={[
            { header: 'Symbol', width: 10 },
            { header: 'Dir', width: 8 },
            { header: 'Conf', width: 8 },
            { header: 'Thr', width: 8 },
            { header: 'Decision', width: 14 },
            { header: 'Reason', width: 32 },
          ]}
          emptyText={consensus.data ? '(no consensus rounds reported)' : '(loading…)'}
          rows={rounds.slice(0, 25).map((r) => {
            const conf = Number(r.confidence ?? 0);
            const thr = Number(r.threshold ?? 0.75);
            const decision = String(r.decision ?? (conf > thr ? 'TRADE' : 'NO_TRADE'));
            const traded = /trade/i.test(decision) && !/no/i.test(decision);
            return [
              <Text bold>{String(r.symbol ?? '?')}</Text>,
              String(r.direction ?? '—'),
              conf ? conf.toFixed(2) : '—',
              thr ? thr.toFixed(2) : '—',
              traded ? <Badge tone="ok">{decision}</Badge> : <Badge tone="dim">{decision}</Badge>,
              <Text wrap="truncate">{String(r.reason ?? r.zeroTradeReason ?? '—')}</Text>,
            ];
          })}
        />
        {consensus.error && <Text color={theme.err}>{consensus.error}</Text>}
        <Text color={theme.dim}>Threshold 0.75, strict &gt; — a 0.75 vote is NO_TRADE by design.</Text>
      </Panel>
    </Box>
  );
}
