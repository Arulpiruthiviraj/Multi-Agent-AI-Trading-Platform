/**
 * TUI entrypoint. Loaded ONLY when `argus tui` / `argus ui` is invoked —
 * zero TUI initialization, polling, or timers otherwise (spec §22).
 */
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

export async function runTui(apiBase: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('argus tui needs an interactive terminal (stdin/stdout must be a TTY).');
    console.error('For scripted output use: argus status | argus dashboard --pretty');
    process.exitCode = 1;
    return;
  }
  const { waitUntilExit } = render(<App apiBase={apiBase} />);
  await waitUntilExit();
}
