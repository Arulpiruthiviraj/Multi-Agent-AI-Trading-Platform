/**
 * ==========================================================
 * Module:
 * main.tsx
 *
 * Purpose:
 * Core implementation and logic for the main.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for mainx
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

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { WebSocketProvider } from './context/WebSocketContext';
import { ExplainerSettingsProvider } from './context/ExplainerSettingsContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebSocketProvider>
      <ExplainerSettingsProvider>
        <App />
      </ExplainerSettingsProvider>
    </WebSocketProvider>
  </StrictMode>,
);
