/**
 * Market screen: market status, data freshness, subscriptions. Read-only.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { TuiApiClient, usePoll } from '../api.js';
import { Panel, KV, DataTable, Badge } from '../components.js';
import { theme } from '../theme.js';

export function MarketScreen({ client, refreshTick }: { client: TuiApiClient; refreshTick: number; compact: boolean }) {
  const market = usePoll(client, (c) => c.marketStatus(), 2000, refreshTick);

  const m: any = market.data;
  const subs: any[] = Array.isArray(m?.subscriptions) ? m.subscriptions : Array.isArray(m?.symbols) ? m.symbols : [];

  return (
    <Box flexDirection="column">
      <Panel title="MARKET STATUS">
        <KV k="Session" v={m?.session ? <Text>{String(m.session)}</Text> : <Text color={theme.dim}>—</Text>} />
        <KV k="Data type" v={m?.marketDataType ? <Text>{String(m.marketDataType)}</Text> : <Text color={theme.dim}>—</Text>} />
        <KV k="Provider" v={m?.provider ? <Text>{String(m.provider)}</Text> : <Text color={theme.dim}>—</Text>} />
        <KV k="Freshness" v={m?.stale ? <Badge tone="err">STALE</Badge> : m ? <Badge tone="ok">FRESH</Badge> : <Text color={theme.dim}>…</Text>} />
        {market.error && <Text color={theme.err}>{market.error}</Text>}
      </Panel>
      <Panel title={`SUBSCRIPTIONS${subs.length ? ` (${subs.length})` : ''}`}>
        <DataTable
          columns={[{ header: 'Symbol', width: 12 }, { header: 'Type', width: 14 }, { header: 'Fresh', width: 10 }]}
          emptyText={market.data ? '(no subscriptions reported)' : '(loading…)'}
          rows={subs.slice(0, 20).map((s) => [
            <Text bold>{String(s.symbol ?? s.ticker ?? '?')}</Text>,
            String(s.type ?? s.feed ?? '—'),
            s.stale === true ? <Badge tone="err">STALE</Badge> : <Badge tone="ok">OK</Badge>,
          ])}
        />
        {subs.length > 20 && <Text color={theme.dim}>… and {subs.length - 20} more</Text>}
      </Panel>
    </Box>
  );
}
