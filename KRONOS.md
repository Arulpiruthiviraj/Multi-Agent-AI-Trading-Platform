# Kronos Forecasting Engine

**Status: 🔴 BROKEN. Cannot produce a single real prediction under any configuration.** This is not a partial or intermittent limitation — it is architecturally guaranteed to fail on every call, on two independent counts, verified directly against source on 2026-08-08.

If you are reading an older revision of this file (or a doc/comment elsewhere that describes Kronos as "fully implemented," "operational," or participating in real trades), it is wrong. Verify against the code below before relying on any Kronos-related claim.

---

## Why it cannot work

### 1. The trigger event is never emitted

`KronosForecastAgent` (`src/server/services/KronosForecastAgent.ts:36`) subscribes like this:

```ts
eventBus.on('MARKET_DATA_UPDATED', async (data: any) => { ... })
```

The only real market-data emitter in the entire codebase is `EventBus.emitMarketData()` (`src/server/core/EventBus.ts:40-42`), and it emits a **different event name**:

```ts
public emitMarketData(symbol, price, volume, timestamp) {
   this.emit('MARKET_DATA', { symbol, price, volume, timestamp });
}
```

A repo-wide search confirms nothing, anywhere, ever emits `'MARKET_DATA_UPDATED'`. `KronosForecastAgent`'s handler has never fired in this codebase's history and cannot fire without a code change.

### 2. Even if triggered, inference unconditionally throws

`KronosInference.predict()` (`src/server/engines/kronos/KronosInference.ts:26-35`) is, in its entirety:

```ts
public async predict(symbol, horizon, timeframe, ohlcvData): Promise<ForecastPrediction> {
    try {
      // In a real environment, this would call a persistent Python server (e.g., via HTTP or ZeroMQ)
      // For now, we will simulate the connection check. Since we don't have the Python service running,
      // we must follow the directive and return unavailable instead of random data.
      throw new Error('KRONOS_UNAVAILABLE: Python inference service is not reachable.');
    } catch (e) {
      throw e;
    }
}
```

There is no conditional branch. It throws every time, regardless of environment variables, model configuration, or anything else. `batchPredict()` has the identical unconditional throw.

**There is no Python inference process anywhere in this repository for this to connect to even if the throw were removed.** The only Python code in the repo is the fully separate, disconnected `python-platform/` FastAPI app, which has no Kronos-related module and is never invoked by the Node process.

### 3. The "model manager" reports a fabricated healthy status anyway

`KronosModelManager.initialize()` (`src/server/engines/kronos/KronosModelManager.ts:15-35`) does two `setTimeout(500ms)` sleeps to simulate loading, then unconditionally sets:

```ts
this.isAvailable = true;
this.memoryUsage = '4.2 GB';
this.gpuUsage = '35%';
this.inferenceTime = 145;
this.updateStatus('Ready');
```

These are hardcoded constants, not measurements of anything real. `GET /api/v1/kronos/status` will report `isAvailable: true` and a "Ready" status — this is a lie about the system's actual capability, not a bug in the reporting itself. The `KronosDashboard.tsx` frontend component renders this fabricated status as if it were real.

### 4. The tokenizer is a stub

`KronosTokenizer.quantize()` (`src/server/engines/kronos/KronosTokenizer.ts`) is one line: `return { tokenized: true };`. There is no real tokenization logic.

---

## What *is* real, for the record

- `KronosPredictionCache` (`KronosPredictionCache.ts`) — a genuine in-memory `Map`-based cache keyed by `(symbol, timeframe)`. It's simply never populated, because nothing successfully produces a prediction to cache.
- `KronosMetrics.recordPrediction()` (`KronosMetrics.ts`) — genuinely writes to the `kronos_predictions` table if called with real data. It's never called with real data, because `KronosEngine.predict()` throws before reaching this step.
- `kronos_predictions` table schema — fully correct and migration-verified. It simply has no real rows, ever, under the current code.
- `KronosEngine` (`KronosEngine.ts`) — the orchestration class itself (`predict()`, `batchPredict()`, `getStatus()`) is correctly structured to call into `KronosInference`, `KronosPredictionCache`, and `KronosMetrics` in the right order. The orchestration logic is not the problem; every component it depends on is either a stub or an unconditional throw.

## Does Kronos influence the final trading decision?

**No.** Not conditionally, not partially. It is architecturally impossible for it to do so under the current code, independent of configuration, API keys, or environment.

## What "fixing" this would actually require

1. Emit `MARKET_DATA_UPDATED` somewhere real (or, more simply, change `KronosForecastAgent` to listen for the real `MARKET_DATA` event — but this alone does nothing, see next point).
2. Stand up an actual inference backend (a Python process, an HTTP API, a GPU runtime — any of these) and replace `KronosInference.predict()`'s unconditional throw with a real call to it.
3. Replace `KronosModelManager`'s fabricated status constants with a real health check against whatever backend is stood up in step 2.
4. Only after 1–3 are done does it make sense to re-enable `KronosForecastAgent`'s `TRADE_IDEA_GENERATED` emission and let `ChiefTraderAgent`'s existing `'KronosEngine': 0.20` default weight actually matter.

None of this exists yet. Do not spend time wiring *downstream* consumers of Kronos output (backtesting, dashboards, weight tuning) until the upstream inference problem is solved — there is nothing for them to consume.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference, § Key Components
- [EVENTBUS.md](./EVENTBUS.md) — confirms the `MARKET_DATA` / `MARKET_DATA_UPDATED` mismatch is real and not the only one
- [RISK_ENGINE.md](./RISK_ENGINE.md) — the risk engine has its own real ATR implementation, unrelated to Kronos
