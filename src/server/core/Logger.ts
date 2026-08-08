/**
 * ==========================================================
 * Module:
 * Logger.ts
 *
 * Purpose:
 * Core implementation and logic for the Logger.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for Logger
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import fs from 'fs';
import path from 'path';

const logsDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

export const logTrade = (trade: any) => {
  const file = path.join(logsDir, 'trades.json');
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...trade }) + '\n');
};

export const logAiDecision = (decision: any) => {
  const file = path.join(logsDir, 'ai-decisions.json');
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...decision }) + '\n');
};

export const logEventTrace = (trace: any) => {
  const file = path.join(logsDir, 'event-traces.json');
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...trace }) + '\n');
};
