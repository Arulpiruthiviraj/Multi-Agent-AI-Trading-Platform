# Frontend Guide - Argus Trading Terminal

Real React frontend architecture, verified against `src/App.tsx`, `src/main.tsx`, `src/context/WebSocketContext.tsx`, and the `src/components/` directory on 2026-08-08. A prior revision of this document invented file paths (`src/hooks/useWebSocket.ts`, `PaperBroker.ts` references) and a tab-based routing structure (`activeTab === 'dashboard'`) that doesn't match how `App.tsx` is actually organized. Corrected below.

---

## 🎨 Tech Stack (verified)

- **Framework**: React 19.0.1 + Vite 6.2.3
- **Language**: TypeScript (no `strict` mode in `tsconfig.json`)
- **Styling**: Tailwind CSS v4 (`@tailwindcss/vite`)
- **Charts**: Recharts 3.8.1
- **Flow diagrams**: ReactFlow 11.11.4
- **Icons**: `lucide-react`
- **Animation**: `motion` (framer-motion successor)
- **State**: React `useState`/`useEffect` — `App.tsx` alone has 60+ `useState` hooks; there is no Redux/Zustand/Context-based global store beyond `WebSocketContext`
- **Real-time**: native `WebSocket`, not Socket.IO

---

## 📁 Directory Structure (real)

```
src/
├── App.tsx                      # ~11,000 lines, single component tree - no router, no tabs-as-routes
├── main.tsx                     # wraps <App /> in <WebSocketProvider>
├── index.css
├── components/                   # 50+ files
├── context/
│   └── WebSocketContext.tsx     # WebSocketProvider + useWebSocket() hook (both live in this one file)
├── hooks/
│   └── useEventBusTrace.ts      # subscribes to a fixed list of event types, filters by traceId
├── marketdata/
│   └── MarketDataManager.ts / MarketDataAdapter.ts / PolygonAdapter.ts / YahooFinanceAdapter.ts
└── brokers/                      # frontend-side broker metadata helpers, separate from src/server/... broker logic
```

There is no `src/hooks/useWebSocket.ts` file — the hook is exported directly from `WebSocketContext.tsx`.

---

## 🏠 Main Application (`App.tsx`)

`App.tsx` is a single default-exported function component with no internal router. Navigation between views is state-driven (`activeTab` and similar `useState` variables control conditional rendering), not route-driven — there's no `<Routes>`/`<Route>` structure and no URL-based deep linking into a specific tab.

### Setup Wizard gating (verified, important)

```tsx
const [setupComplete, setSetupComplete] = useState(false);
// ...
{!setupComplete && (
  <SetupWizard onSkip={() => setSetupComplete(true)} onComplete={async (config) => {
    // Only POSTs AI provider keys to /api/v1/config/providers.
    // Budget/risk/strategy/tradingMode are set into local React state only.
    setSetupComplete(true);
  }} />
)}
```

- `setupComplete` is a plain component-local boolean — **no `localStorage`, no cookie, no backend flag**. The wizard reappears on every browser refresh.
- `onSkip` dismisses the overlay and persists nothing.
- The rest of the dashboard (`AppWalkthrough`, `LiveMarketNewsTicker`, header bars, etc.) renders regardless of `setupComplete`'s value — the wizard is an overlay, not a blocking gate around the whole app.
- **This has zero backend enforcement power.** `SystemBootstrap.start()` and every background worker run unconditionally regardless of whether this wizard ever completed — see [AI_CONTEXT.md](./AI_CONTEXT.md) §5.

### Real WebSocket subscriptions (verified count: 2)

A repo-wide search of `App.tsx` for `subscribe(` finds exactly two calls to `useWebSocket().subscribe()`:
```tsx
const unsubscribe = subscribe('AUTOBOT_STATE_UPDATED', (data) => { ... });
const unsubscribe = subscribe('TRADE_IDEA_GENERATED', (data) => { ... });
```
Every other real broadcast event type (risk decisions, order executions, calculation results, news analysis, Kronos events, system metrics, market regime) reaches the browser over the wildcard WebSocket forwarding (see [EVENTBUS.md](./EVENTBUS.md)) and is **not consumed by anything in `App.tsx`**. Most dashboards instead poll REST endpoints on an interval or on mount.

---

## Component inventory (real files, `src/components/`)

Selected components with verified real/mock status (see [AI_CONTEXT.md](./AI_CONTEXT.md) and other docs for the backend side of each):

| Component | Real backend data? | Notes |
|---|---|---|
| `AutonomousMissionControl.tsx` | ✅ | Real bot controls, calls `/api/v1/autobot/toggle` |
| `AutonomousDashboard.tsx` | ✅ | Real telemetry via `/api/v1/autobot` polling + `AUTOBOT_STATE_UPDATED` |
| `GuardrailsPanel.tsx` | 🟡 | Risk settings persist for real; the take-profit/trailing-stop sliders specifically have no effect on actual exit logic — see [RISK_ENGINE.md](./RISK_ENGINE.md) |
| `KronosDashboard.tsx` | 🔴 | Renders `/api/v1/kronos/status`'s fabricated "Ready" state and whatever (always-empty) rows exist in `kronos_predictions` — see [KRONOS.md](./KRONOS.md) |
| `AgentTopologyMap.tsx` | 🟡 | Real agent names/weights if wired to fetch `agent_performance_stats`; verify against current fetch calls before assuming live data |
| `AIProviderManagement.tsx` | 🟡 | Real CRUD against `ai_providers`; a newly-added provider needs a server restart before `AIRouter` actually routes to it (§ AI_CONTEXT.md) |
| `BrokerManagement.tsx` | 🔴 misleading | Lists Questrade/Interactive Brokers/Coinbase alongside Alpaca with no indication that the first three throw on the first real order — see [BROKER_ENGINE.md](./BROKER_ENGINE.md) |
| `ContextMemoryEngineering.tsx` | 🟡 | Displays real `learned_rules`/`memory_rules` rows; those rules are never actually injected into any agent prompt — the UI implies a closed loop that doesn't exist on the backend |
| `NewsDashboardTab.tsx`, `LiveMarketNewsTicker.tsx`, `AlpacaNewsTicker.tsx` | ✅ | Real, backed by the real news pipeline |
| `SetupWizard.tsx` | 🟠 | See gating notes above |
| `AppWalkthrough.tsx` | 🟠 | UI-only guided tour, no backend interaction |
| `TradeReplayModal.tsx` | 🟠 | Prototype per prior audit reports; playback controls are visual only |
| `LiveTradeJourneyOverlay.tsx` | ⚪ | Historically mocked-timer-driven animation, not tied to real EventBus trace logs — verify current state before building on it |

**~9 chart panels render hardcoded, static data** defined as module-scope constants near the top of `App.tsx` (before the `App` function): `mockSystemLatencyData`, `mockWinRateData`, `mockDrawdownData`, `mockBacktestData`, `mockBenchmarkData`, `mockTokenConsumptionData`, `mockHeatmapData`, `mockRiskDecompositionData`, `mockSwarmTranscripts`. Each is confirmed referenced 2–3 times in the file (definition + JSX usage), i.e. genuinely rendered, not dead code. If you're asked to make one of these panels "real," the fix is to replace its data source with a real fetch, not to assume it already is one.

---

## 🌐 WebSocket Integration (real)

**Location**: `src/context/WebSocketContext.tsx` — provides both `WebSocketProvider` and the `useWebSocket()` hook in one file.

```tsx
// Real, current implementation (abbreviated)
export const WebSocketProvider = ({ children }) => {
  const connect = () => {
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`); // note the /ws path
    ws.onopen = () => { /* start 5s heartbeat ping, reset reconnect counter */ };
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === 'pong') { /* update lastPong timestamp */ return; }
      setLastMessage(payload);
      if (payload.type && subscribers.current.has(payload.type)) {
        subscribers.current.get(payload.type).forEach(cb => cb(payload.data));
      }
    };
    ws.onclose = () => { /* exponential backoff reconnect: min(1000 * 2^attempts, 30000) */ };
  };
  // ...
  return <WebSocketContext.Provider value={{status, lastMessage, sendMessage, subscribe}}>{children}</WebSocketContext.Provider>;
};

export const useWebSocket = () => {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within a WebSocketProvider');
  return ctx;
};
```

`subscribe(eventType, callback)` returns an unsubscribe function and only fires `callback` for messages whose `type` field matches `eventType` exactly — since `type` is the real EventBus event name (see [EVENTBUS.md](./EVENTBUS.md)), subscribing to the wrong string (e.g. a name from an older doc revision) silently does nothing.

### `useEventBusTrace` hook (real, works correctly as of current server-side wildcard forwarding)

```tsx
// src/hooks/useEventBusTrace.ts, real
const handlers = ['TRADE_IDEA_GENERATED', 'CHIEF_APPROVED_IDEA', 'RISK_ASSESSMENT_COMPLETED',
  'ORDER_EXECUTED', 'LEARNED_NEW_RULE', 'MARKET_DATA', 'QUANT_ENGINE_OUTPUT', 'SYSTEM_METRICS', 'CALCULATION_COMPLETED'];
// subscribes to all of them, filters by data.traceId === targetTraceId, accumulates into traceEvents
```
Note: `'QUANT_ENGINE_OUTPUT'` is listed here but nothing in the backend emits that exact string (`AdvancedQuantEngines` emits via `emitCalculation(..., 'AdvancedQuantEngine', ...)`, which produces a `CALCULATION_COMPLETED` event, not `QUANT_ENGINE_OUTPUT`) — that specific subscription in the handler list is a dead entry, though the hook still works for the other 8 event types.

---

## 🎨 Design System (real, this part of prior docs was accurate)

```css
--bg-primary: #0A0F16;
--bg-secondary: #1A1F2B;
--accent-buy: #10B981;     /* emerald-500 */
--accent-sell: #EF4444;    /* rose-500 */
--accent-primary: #6366F1; /* indigo-500 */
--accent-warning: #F59E0B; /* amber-500 */
```
Heavy `font-mono`, `uppercase`, `tracking-widest` usage on headers/labels; glass-morphism panels (`backdrop-blur-xl bg-white/5 border border-white/10`); this is a consistent, real pattern across the codebase.

---

## 🧪 Testing

**There are no component tests.** No Vitest/Jest config, no React Testing Library usage found anywhere in `src/`. A prior revision of this document included a `describe('AutonomousMissionControl', ...)` example test — it does not correspond to any real test file in this repository.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [API_REFERENCE.md](./API_REFERENCE.md) — real endpoints these components call
- [EVENTBUS.md](./EVENTBUS.md) — real WebSocket message catalog
