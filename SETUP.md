# Application Setup & Deployment Guide

This guide details how to install, configure, and execute the Argus Trading Platform.

## Prerequisites

- Node.js (v18 or higher recommended)
- `npm` package manager
- A Google Gemini API key (optional but recommended to activate the live Intelligence Layer capabilities)

## 1. Environment Variable Setup

1. Create a `.env` file in the root workspace directory.
2. If you want to enable the live LLM components and qualitative sentiment analysis, supply your Gemini API key:
   ```env
   GEMINI_API_KEY=your_api_key_here
   ```
   _Note: If no API key is provided, the backend will safely handle the exception and fall back to local mathematical distribution simulators for consensus generation._
3. If you want to use real broker data and executions, supply your Alpaca Trading API credentials (you do NOT need the Broker API, you need the **Individuals Trading API**):
   ```env
   ALPACA_API_KEY=your_alpaca_api_key_here
   ALPACA_SECRET_KEY=your_alpaca_secret_key_here
   ```

### Where to get Alpaca API Keys?
For this application, you need the **Trading API** for individuals (not the Broker API meant for building apps for third-party endpoints).
1. Sign up for a free account at [alpaca.markets](https://alpaca.markets/).
2. Log into your dashboard and ensure you are in the **Paper Trading** environment (to use simulated money).
3. On the right-hand side of your dashboard home screen, find the "Your API Keys" box.
4. Click **Generate New Key**.
5. Copy the **API Key ID** (`ALPACA_API_KEY`) and **Secret Key** (`ALPACA_SECRET_KEY`) into your `.env` file.

## 2. Installation

Run the following command to hydrate the `node_modules` directory with dependencies specified in the `package.json`:

```bash
npm install
```

## 3. Running in Development Mode

Execute the custom dev script to start the Node express backend with Vite SPA middleware natively injected. This allows for live asset serving and REST API usage concurrently on standard port 3000.

```bash
npm run dev
```

## 4. Production Build Subsystem

The production build script generates outputs for both the frontend React application and the backend Express server.

```bash
npm run build
```

This multi-step command executes:

1. `vite build`: Compiles the React SPA into static minified assets in the `/dist` directory.
2. `esbuild`: Compiles the Express `server.ts` into a self-contained, dependency-external CommonJS bundle output at `/dist/server.cjs`.

## 5. Running the Production Server

Start the compiled, production-ready Node.js backend:

```bash
npm run start
```

The runtime will internally serve the static SPA fallback routing and expose the core REST architecture simultaneously on port `3000`.

## 6. Embedded Risk Engines & Mathematical Gating

The terminal includes advanced mathematical guardrails running entirely on the server-side architecture:
- **14-period Average True Range (ATR) Calculator:** Automatically computes asset price volatility using Wilder's smoothed moving average.
- **Dynamic Risk Sizer:** Automatically scales down trade allocations based on system risk tolerances (Low: 1.0%, Medium: 1.5%, High: 3.0% of total budget).
- **Hard Stop-Loss Floor:** Forces stop-loss thresholds to a minimum of 1.5x of the calculated ATR, safeguarding positions against market noise.
- **Real-Time Telemetry visualizer:** High-density status indicators overlaying the autonomous decision graph in the frontend.

