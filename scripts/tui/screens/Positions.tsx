/**
 * Positions screen: positions + orders from existing endpoints. Read-only.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { TuiApiClient, usePoll } from '../api.js';
import { Panel, DataTable, Badge } from '../components.js';
import { theme } from '../theme.js';

export function PositionsScreen({ client, refreshTick }: { client: TuiApiClient; refreshTick: number; compact: boolean }) {
  const portfolio = usePoll(client, (c) => c.portfolio(), 5000, refreshTick);
  const orders = usePoll(client, (c) => c.orders(), 5000, refreshTick);

  const holdings: any[] = Array.isArray((portfolio.data as any)?.portfolio) ? (portfolio.data as any).portfolio : [];
  const orderList: any[] = Array.isArray((orders.data as any)?.orders) ? (orders.data as any).orders : [];

  return (
    <Box flexDirection="column">
      <Panel title={`POSITIONS${holdings.length ? ` (${holdings.length})` : ''}`}>
        <DataTable
          columns={[
            { header: 'Symbol', width: 10 },
            { header: 'Qty', width: 8 },
            { header: 'Avg', width: 10 },
            { header: 'MktVal', width: 12 },
            { header: 'Unrl P&L', width: 14 },
            { header: 'Source', width: 12 },
          ]}
          emptyText={portfolio.data ? '(no open positions)' : '(loading…)'}
          rows={holdings.slice(0, 20).map((p) => {
            const u = Number(p.unrealizedPnl ?? p.unrealizedPL ?? 0);
            return [
              <Text bold>{String(p.symbol ?? p.ticker ?? '?')}</Text>,
              String(p.quantity ?? p.qty ?? 0),
              `$${Number(p.avgPrice ?? p.averageCost ?? 0).toFixed(2)}`,
              `$${Number(p.marketValue ?? p.currentValue ?? 0).toFixed(2)}`,
              <Text color={u > 0 ? theme.ok : u < 0 ? theme.err : theme.dim}>
                {Number.isFinite(u) ? `${u >= 0 ? '+' : ''}$${u.toFixed(2)}` : '—'}
              </Text>,
              String(p.source ?? '—'),
            ];
          })}
        />
        {portfolio.error && <Text color={theme.err}>{portfolio.error}</Text>}
      </Panel>
      <Panel title={`ORDERS${orderList.length ? ` (${orderList.length})` : ''}`}>
        <DataTable
          columns={[
            { header: 'ID', width: 14 },
            { header: 'Symbol', width: 10 },
            { header: 'Side', width: 6 },
            { header: 'Qty', width: 8 },
            { header: 'Status', width: 14 },
          ]}
          emptyText={orders.data ? '(no orders reported)' : '(loading…)'}
          rows={orderList.slice(0, 15).map((o) => {
            const st = String(o.status ?? '—').toUpperCase();
            const tone = /fill/i.test(st) ? 'ok' : /reject|cancel|fail/i.test(st) ? 'err' : /pend|work|open|submit/i.test(st) ? 'warn' : 'dim';
            return [
              <Text wrap="truncate">{String(o.id ?? o.orderId ?? '?')}</Text>,
              <Text bold>{String(o.symbol ?? '?')}</Text>,
              String(o.side ?? '—'),
              String(o.quantity ?? o.qty ?? 0),
              <Badge tone={tone as 'ok' | 'err' | 'warn' | 'dim'}>{st}</Badge>,
            ];
          })}
        />
        {orders.error && <Text color={theme.err}>{orders.error}</Text>}
      </Panel>
    </Box>
  );
}
