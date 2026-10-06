/**
 * Argus TUI shell (2026-10-06): mainframe-style operations terminal.
 * Keyboard-first, read-only by default. The safety banner (PAPER/LIVE +
 * LIVE_NO_GO + trading state) is always visible and never hidden by navigation.
 */
import React, { useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { TuiApiClient, usePoll } from './api.js';
import { ModeBadge, ReadinessBadge, StateBadge, theme } from './theme.js';
import { OverviewScreen } from './screens/Overview.js';
import { MarketScreen } from './screens/Market.js';
import { AgentsScreen } from './screens/Agents.js';
import { ConsensusScreen } from './screens/Consensus.js';
import { RiskScreen } from './screens/Risk.js';
import { PositionsScreen } from './screens/Positions.js';
import { LogsScreen } from './screens/Logs.js';
import { ReflectionScreen } from './screens/Reflection.js';

const PAGES = [
  { key: '1', name: 'Overview', el: OverviewScreen },
  { key: '2', name: 'Market', el: MarketScreen },
  { key: '3', name: 'Agents', el: AgentsScreen },
  { key: '4', name: 'Consensus', el: ConsensusScreen },
  { key: '5', name: 'Risk', el: RiskScreen },
  { key: '6', name: 'Positions', el: PositionsScreen },
  { key: '7', name: 'Logs', el: LogsScreen },
  { key: '8', name: 'Reflection', el: ReflectionScreen },
] as const;

function HelpOverlay({ onClose }: { onClose: () => void }) {
  useInput((_input, key) => {
    if (key.escape || _input === '?' || _input === 'q') onClose();
  });
  const rows: [string, string][] = [
    ['1-8', 'switch page'],
    ['r', 'refresh current page'],
    ['?', 'this help'],
    ['q', 'quit'],
    ['Esc', 'close overlay / back'],
  ];
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.border} paddingX={2} paddingY={1}>
      <Text bold color={theme.info}>KEYBOARD SHORTCUTS</Text>
      {rows.map(([k, d]) => (
        <Box key={k}><Box width={8}><Text bold>{k}</Text></Box><Text color={theme.dim}>{d}</Text></Box>
      ))}
      <Text color={theme.dim}>Press ? or Esc to close</Text>
    </Box>
  );
}

export function App({ apiBase }: { apiBase: string }) {
  const { exit } = useApp();
  const [page, setPage] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const client = useMemo(() => new TuiApiClient(apiBase), [apiBase]);

  // Safety banner data: polled at 2s, independent of the active page.
  const banner = usePoll(client, (c) => c.status(), 2000);
  const ready = usePoll(client, (c) => c.readiness(), 10000);

  const status: any = banner.data;
  const tradingState = status?.tradingState ?? status?.status?.tradingState;
  const tradingMode = status?.tradingMode ?? status?.status?.tradingMode ?? 'PAPER';
  const readinessVal: string | undefined = (ready.data as any)?.verdict ?? (ready.data as any)?.readiness;

  useInput((input, key) => {
    if (helpOpen) return; // overlay handles its own keys
    const idx = PAGES.findIndex((p) => p.key === input);
    if (idx >= 0) { setPage(idx); return; }
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return; }
    if (input === 'r') { setRefreshTick((t) => t + 1); return; }
    if (input === '?') { setHelpOpen(true); return; }
  });

  const Page = PAGES[page].el;
  const now = new Date().toLocaleTimeString('en-US', { hour12: false });
  const termWidth = typeof process.stdout?.columns === 'number' ? process.stdout.columns : 100;
  const compact = termWidth < 90;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Safety banner — always visible */}
      <Box borderStyle="double" borderColor={theme.border} paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold color={theme.info}>ARGUS QUANT TERMINAL</Text>
          <Text>  </Text>
          <ModeBadge mode={tradingMode} />
          <Text> </Text>
          <ReadinessBadge readiness={readinessVal} />
          <Text> </Text>
          <StateBadge state={tradingState} />
        </Box>
        <Text color={theme.dim}>{compact ? now : `${now} ET`}</Text>
      </Box>

      {banner.error && !banner.data ? (
        <Box flexDirection="column" paddingY={1}>
          <Text bold color={theme.err}>ARGUS ENGINE UNAVAILABLE</Text>
          <Text color={theme.dim}>{banner.error}</Text>
          <Text color={theme.dim}>Press r to retry, q to quit. The TUI never fabricates data.</Text>
        </Box>
      ) : helpOpen ? (
        <Box paddingY={1} justifyContent="center"><HelpOverlay onClose={() => setHelpOpen(false)} /></Box>
      ) : (
        <Box paddingY={1} flexDirection="column">
          <Page client={client} refreshTick={refreshTick} compact={compact} />
        </Box>
      )}

      {/* Footer nav */}
      <Box borderStyle="single" borderColor={theme.border} paddingX={1}>
        <Text>
          {PAGES.map((p, i) => (
            <Text key={p.key}>
              <Text color={i === page ? theme.info : theme.dim} bold={i === page}>[{p.key}] {p.name}</Text>
              <Text> </Text>
            </Text>
          ))}
          <Text color={theme.dim}>[?] Help [r] Refresh [q] Quit</Text>
        </Text>
      </Box>
    </Box>
  );
}
