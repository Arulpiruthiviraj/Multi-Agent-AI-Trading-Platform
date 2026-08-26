/**
 * ==========================================================
 * Module:
 * BrokerManager.ts
 *
 * Purpose:
 * Core implementation and logic for the BrokerManager.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for BrokerManager
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


import { QuestradeBroker } from './QuestradeBroker';
import { InteractiveBrokersWebApiAdapter } from './InteractiveBrokersWebApiAdapter';
import { IBGatewaySocketAdapter } from './IBGatewaySocketAdapter';
import { CoinbaseBroker } from './CoinbaseBroker';
import { BrokerPlugin } from './BrokerAdapter';
import { InternalPaperBroker } from './InternalPaperBroker';
import { AlpacaBroker } from './AlpacaBroker';
import { db } from '../server/db';
import * as schema from '../server/db/schema';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../server/core/EncryptionService';
import { LIVE_TRADING_CONFIRMATION_PHRASE, armLiveTrading, disarmLiveTrading } from '../server/core/LiveTradingConfirmation';
import { eventBus } from '../server/core/EventBus';
import { EVENTS } from '../server/core/eventNames';
import { getActiveReplaySession } from '../server/replay/ReplayContext';
import { logErrorSafely } from '../server/core/SecretRedaction';

// placeOrder() throws 'Not implemented' on every one of these - confirmed non-functional stubs,
// not partial implementations. Never allow them to become the active (order-placing) broker.
// ibkr_gateway / ibkr_web are real order paths (OMS sole placeOrder). coinbase was moved off
// NON_FUNCTIONAL once Advanced Trade API landed. questrade remains permanently non-functional for orders.
const NON_FUNCTIONAL_BROKER_IDS = new Set(['questrade']);

export type BrokerSyncState = 'INITIALIZING' | 'READY' | 'SYNCING' | 'FAILED';

export class BrokerManager {
  private static instance: BrokerManager;
  private activeBroker: BrokerPlugin;
  private brokers: Map<string, BrokerPlugin> = new Map();
  private paperTickFromMarketData = false;
  private syncState: BrokerSyncState = 'READY';

  private constructor() {
     // Default active broker is InternalPaperBroker, seeded with
     // tradingSafety.internalPaperDefaultCash (paperInitialCapital). That seed is not
     // settings.maxTradeSize / defaultMaxTradeSizeDollars (order-notional cap).
     this.activeBroker = new InternalPaperBroker();
  }

  public static getInstance(): BrokerManager {
    if (!BrokerManager.instance) {
      BrokerManager.instance = new BrokerManager();
    }
    return BrokerManager.instance;
  }

  public getSyncState(): BrokerSyncState {
    return this.syncState;
  }

  /** True when broker init finished and no in-flight portfolio sync holds SYNCING. */
  public isReadyForReconciliation(): boolean {
    return this.syncState === 'READY';
  }

  public beginBrokerSync(): void {
    if (this.syncState === 'READY') this.syncState = 'SYNCING';
  }

  public endBrokerSync(): void {
    if (this.syncState === 'SYNCING') this.syncState = 'READY';
  }

  /** Test-only: pin sync gate without running full initialize() (vitest workers share this singleton). */
  public resetSyncStateForTests(state: BrokerSyncState = 'READY'): void {
    this.syncState = state;
  }
  
  public async initialize() {
     this.syncState = 'INITIALIZING';
     try {
         const internalPaper = new InternalPaperBroker();
         const alpaca = new AlpacaBroker();
         const questrade = new QuestradeBroker();
         const ibkrGateway = new IBGatewaySocketAdapter();
         const ibkrWeb = new InteractiveBrokersWebApiAdapter();
         const coinbase = new CoinbaseBroker();
         
         this.brokers.set(internalPaper.id, internalPaper);
         this.brokers.set(alpaca.id, alpaca);
         this.brokers.set(questrade.id, questrade);
         this.brokers.set(ibkrGateway.id, ibkrGateway);
         this.brokers.set(ibkrWeb.id, ibkrWeb);
         this.brokers.set(coinbase.id, coinbase);
         
         // Initialize plugins
         for (const broker of this.brokers.values()) {
             await broker.initialize();
         }
         
         const settings = await db.select().from(schema.settings).limit(1);

         const { selectedName, selectionSource } = BrokerManager.resolveBootBrokerSelection({
             envActiveBroker: process.env.ARGUS_ACTIVE_BROKER,
             forceEnvBrokerOnBoot: process.env.ARGUS_FORCE_ENV_BROKER_ON_BOOT === 'true',
             persistedSelection: settings[0]?.selectedBroker,
         });

         const brokerConnections = await db.select().from(schema.brokerConnections);

         let activeFound = false;
         // ARGUS_ACTIVE_BROKER naturally arrives as an id (e.g. "ibkr_gateway"); a persisted UI
         // selection is a display name (e.g. "IBKR Gateway (Socket)"). Resolve once so either form
         // matches below without changing how the existing display-name path behaves.
         const resolvedSelectedId = this.resolveBrokerIdFromSelectedName(selectedName);

         for (const [id, broker] of this.brokers.entries()) {
             if (NON_FUNCTIONAL_BROKER_IDS.has(id)) continue;
             if (
                 broker.name === selectedName ||
                 id === selectedName ||
                 (resolvedSelectedId && id === resolvedSelectedId) ||
                 (selectedName === 'Simulation Mode' && id === 'internal_paper')
             ) {
                 this.activeBroker = broker;
                 activeFound = true;
                 break;
             }
         }

         if (!activeFound) {
             console.warn(`[BrokerManager] Broker selection '${selectedName}' (from ${selectionSource}) is unavailable or non-functional. Falling back to Internal Paper Simulator.`);
             this.activeBroker = internalPaper;
         } else {
             console.log(`[BrokerManager] Boot broker selection: '${this.activeBroker.name}' (source: ${selectionSource}).`);
             // Keep settings.selectedBroker in sync when the env layer is what actually decided —
             // same persist-on-activation pattern POST /brokers/active already uses, so Settings >
             // Brokers reflects reality and a later plain restart (no force) still resolves the
             // same way via the persisted-selection branch above.
             if (selectionSource !== 'settings.selectedBroker (last UI selection)' && settings.length > 0) {
                 await db.update(schema.settings).set({ selectedBroker: this.activeBroker.name }).where(eq(schema.settings.id, settings[0].id));
             }
         }

         // Look up the connection row for the broker we actually resolved above - not for
         // selectedName independently, which could point at a different broker than activeBroker
         // ended up being (e.g. after the non-functional/unavailable fallback just above).
         const connection = brokerConnections.find(b => b.brokerName === this.activeBroker.name);

         if (connection) {
             // Only pass through credentials this specific broker's own connection row actually has.
             // No cross-broker fallback here - each adapter owns its own env-var fallback internally
             // (e.g. AlpacaBroker.authenticate() falls back to process.env.ALPACA_* when no apiKey is
             // passed). Hardcoding Alpaca's env vars as a universal fallback for any broker was the
             // credential leak: a Questrade/IBKR connection with a missing key would have silently
             // authenticated using Alpaca's credentials instead of failing.
             let key: string | undefined;
             let secret: string | undefined;
             let decryptionFailed = false;
             try {
               key = connection.apiKeyEncrypted ? EncryptionService.decrypt(connection.apiKeyEncrypted) : undefined;
               secret = connection.secretEncrypted ? EncryptionService.decrypt(connection.secretEncrypted) : undefined;
             } catch {
               decryptionFailed = true;
               console.error('[BrokerManager] DECRYPTION_FAILED for stored broker credentials — refusing to use plaintext fallback.');
             }

             if (decryptionFailed) {
                 // Real bug found and fixed this pass: logging "refusing to use plaintext
                 // fallback" but then still calling authenticate({apiKey: undefined, secretKey:
                 // undefined, ...}) did NOT actually refuse anything - each adapter's own
                 // authenticate() falls back to its process.env.* credentials when no key is
                 // passed (the exact pattern the comment above this block documents as intentional
                 // for the *normal*, no-stored-connection case). So a corrupted/rotated
                 // encryption key silently authenticated this broker against whatever unrelated
                 // credentials happened to be in env vars instead of refusing to activate it.
                 // Fail closed the same way an unavailable/non-functional saved selection already
                 // does a few lines above: fall back to the safe Internal Paper Simulator instead
                 // of authenticating with unknown credentials.
                 console.error(`[BrokerManager] Refusing to activate '${this.activeBroker.name}' with undecryptable credentials — falling back to Internal Paper Simulator.`);
                 this.activeBroker = internalPaper;
                 await this.activeBroker.authenticate({ initialCash: 100000 });
             } else {
                 if (connection.paperMode) {
                     this.activeBroker.paperTrading();
                 } else {
                     this.activeBroker.liveTrading();
                 }

                 await this.activeBroker.authenticate({
                   apiKey: key,
                   secretKey: secret,
                   isLive: connection.paperMode === false,
                 });
             }
         } else if (this.activeBroker.id === 'alpaca') {
             const mode = String(settings[0]?.tradingMode || '').toUpperCase();
             await this.activeBroker.authenticate({ isLive: mode === 'LIVE' });
         } else {
             await this.activeBroker.authenticate({ initialCash: 100000 });
         }

         this.wireInternalPaperTicksFromMarketData();

         // Real bug found and fixed this pass: setActiveBroker() (the mid-session broker switch)
         // already calls applyMarketDataBinding() to rebind MarketDataWorker's quote backend and
         // register the IBKR reqHistoricalData bridge (registerHistoricalBarProvider) - but
         // initialize() (the boot path, which restores the previously-selected broker from
         // settings.selectedBroker above) never did. So after any server restart with IBKR Gateway
         // saved as the active broker, Settings > Brokers correctly showed it as active/connected,
         // yet HistoricalDataProviderRegistry.ts's ibkrProvider stayed DATA_PROVIDER_UNAVAILABLE
         // (getRegisteredHistoricalBarProvider() was still null) and a replay with
         // dataProvider: 'ibkr' failed DATA_UNAVAILABLE - not because IB Gateway wasn't really
         // connected, but because this rebind step had only ever run on an explicit broker switch,
         // never on boot.
         await this.applyMarketDataBinding(this.activeBroker);

         console.log(`[BrokerManager] Initialized with Active Broker: ${this.activeBroker.name}`);
         this.syncState = 'READY';
     } catch (e) {
         logErrorSafely('[BrokerManager] Init Failed', e);
         this.wireInternalPaperTicksFromMarketData();
         this.syncState = 'FAILED';
     }
  }

  public registerBroker(broker: BrokerPlugin) {
    this.brokers.set(broker.id, broker);
  }

  /**
   * Pure boot-time precedence between the .env broker default and the last broker selected via
   * Settings > Brokers > SET ACTIVE (settings.selectedBroker). Extracted from initialize() so the
   * precedence rule itself is unit-testable without the real DB/adapter side effects initialize()
   * carries. See ARGUS_ACTIVE_BROKER / ARGUS_FORCE_ENV_BROKER_ON_BOOT in .env.example.
   */
  public static resolveBootBrokerSelection(opts: {
    envActiveBroker?: string | null;
    forceEnvBrokerOnBoot: boolean;
    persistedSelection?: string | null;
  }): { selectedName: string; selectionSource: string } {
    const envActiveBroker = opts.envActiveBroker?.trim() || undefined;
    const persistedSelection = opts.persistedSelection?.trim() || undefined;

    if (opts.forceEnvBrokerOnBoot && envActiveBroker) {
      return { selectedName: envActiveBroker, selectionSource: 'ARGUS_FORCE_ENV_BROKER_ON_BOOT' };
    }
    if (persistedSelection) {
      return { selectedName: persistedSelection, selectionSource: 'settings.selectedBroker (last UI selection)' };
    }
    if (envActiveBroker) {
      return { selectedName: envActiveBroker, selectionSource: 'ARGUS_ACTIVE_BROKER (no prior UI selection)' };
    }
    return { selectedName: 'Simulation Mode', selectionSource: 'default' };
  }

  /**
   * Resolve a settings.selectedBroker display name (or id alias) to a registered broker id.
   * Returns null when nothing matches — callers must not invent a second execution path.
   */
  public resolveBrokerIdFromSelectedName(selectedName: string): string | null {
    const raw = String(selectedName || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (lower === 'simulation mode' || lower === 'internal_paper') return 'internal_paper';
    if (lower === 'alpaca') return 'alpaca';
    if (lower === 'ibkr_gateway' || lower === 'ibkr gateway (socket)' || lower === 'ib gateway') return 'ibkr_gateway';
    if (lower === 'ibkr_web' || lower === 'ibkr web api (client portal)' || lower === 'ibkr web') return 'ibkr_web';
    // Alias — resolved to gateway or web at setActiveBroker time via resolveIbkrAlias().
    if (lower === 'ibkr' || lower === 'interactive brokers') return 'ibkr';
    if (lower === 'coinbase') return 'coinbase';
    for (const [id, broker] of this.brokers.entries()) {
      if (broker.name === raw || broker.name.toLowerCase() === lower || id === lower) return id;
    }
    return null;
  }

  /** Prefer IB Gateway socket when :4002/:7497 is open; else Client Portal web. Never opens a browser. */
  public async resolveIbkrAlias(): Promise<'ibkr_gateway' | 'ibkr_web'> {
    const { loadIbkrConnection, ibkrSocketPortCandidates } = await import('../server/config/ibkrConnection');
    const { findFirstOpenTcpPort, probeTcpPort } = await import('./ibkrTcpProbe');
    const cfg = loadIbkrConnection();
    const socketPort = await findFirstOpenTcpPort(cfg.host, ibkrSocketPortCandidates(cfg, false), 1500);
    if (socketPort != null) return 'ibkr_gateway';
    const webOpen = await probeTcpPort('127.0.0.1', 5000, 1200);
    if (webOpen) return 'ibkr_web';
    // Default primary — fail later with a clear socket diagnostic.
    return 'ibkr_gateway';
  }

  /**
   * Load decrypted credentials + paperMode from brokerConnections for a registered broker.
   * Never falls back to another broker's keys. Env-var fallback remains inside each adapter.
   */
  private async loadStoredCredentialsForBroker(broker: BrokerPlugin): Promise<{
    apiKey?: string;
    secretKey?: string;
    paperMode: boolean;
    decryptionFailed: boolean;
  }> {
    const rows = await db.select().from(schema.brokerConnections);
    const connection = rows.find((b) => b.brokerName === broker.name);
    if (!connection) {
      return { paperMode: true, decryptionFailed: false };
    }
    let apiKey: string | undefined;
    let secretKey: string | undefined;
    let decryptionFailed = false;
    try {
      apiKey = connection.apiKeyEncrypted ? EncryptionService.decrypt(connection.apiKeyEncrypted) : undefined;
      secretKey = connection.secretEncrypted ? EncryptionService.decrypt(connection.secretEncrypted) : undefined;
    } catch {
      decryptionFailed = true;
    }
    return {
      apiKey,
      secretKey,
      paperMode: connection.paperMode !== false,
      decryptionFailed,
    };
  }

  /**
   * Mid-session switch of the order-placing broker. OMS remains the sole placeOrder caller.
   * IDs: alpaca | ibkr_gateway | ibkr_web | ibkr (auto) | internal_paper | coinbase.
   */
  public async setActiveBroker(id: string, credentials?: any): Promise<boolean> {
    let resolvedId = id;
    if (id === 'ibkr') {
      resolvedId = await this.resolveIbkrAlias();
      console.log(`[BrokerManager] Alias ibkr → ${resolvedId}`);
    }

    const broker = this.brokers.get(resolvedId);
    if (!broker) throw new Error(`Broker ${resolvedId} not found`);
    if (NON_FUNCTIONAL_BROKER_IDS.has(resolvedId)) {
      throw new Error(`Broker '${broker.name}' is not a functional adapter (placeOrder is unimplemented). Refusing to select it as active.`);
    }

    const paperOnly = process.env.PAPER_TRADING_ONLY === 'true';
    let authPayload: Record<string, unknown> =
      credentials && typeof credentials === 'object' ? { ...credentials } : {};

    if (!credentials || (typeof credentials === 'object' && !credentials.apiKey && !credentials.secretKey && credentials.initialCash === undefined)) {
      const stored = await this.loadStoredCredentialsForBroker(broker);
      if (stored.decryptionFailed) {
        throw new Error(
          `Stored credentials for '${broker.name}' could not be decrypted — refusing to activate. Re-enter keys in Broker settings or fall back to Internal Paper.`,
        );
      }
      if (stored.apiKey !== undefined) authPayload.apiKey = stored.apiKey;
      if (stored.secretKey !== undefined) authPayload.secretKey = stored.secretKey;
      if (authPayload.isLive === undefined) authPayload.isLive = stored.paperMode === false;
      if (resolvedId === 'internal_paper' && authPayload.initialCash === undefined) {
        authPayload.initialCash = 100000;
      }
      if (paperOnly || stored.paperMode) {
        broker.paperTrading();
        authPayload.isLive = false;
      } else {
        broker.liveTrading();
        authPayload.isLive = true;
      }
    } else if (authPayload.isLive === true && !paperOnly) {
      broker.liveTrading();
    } else {
      broker.paperTrading();
      authPayload.isLive = false;
    }

    if (paperOnly && authPayload.isLive === true) {
      throw new Error(
        'PAPER_TRADING_ONLY=true — refusing to activate a LIVE broker session. Keep paper mode for Alpaca/IBKR.',
      );
    }
    if (paperOnly) {
      broker.paperTrading();
      authPayload.isLive = false;
    }

    if (resolvedId === 'ibkr_gateway') {
      const { loadIbkrConnection, ibkrSocketPortCandidates } = await import('../server/config/ibkrConnection');
      const { findFirstOpenTcpPort } = await import('./ibkrTcpProbe');
      const cfg = loadIbkrConnection();
      const preferLive = process.env.PAPER_TRADING_ONLY !== 'true' && authPayload.isLive === true;
      const openPort = await findFirstOpenTcpPort(cfg.host, ibkrSocketPortCandidates(cfg, preferLive), 1500);
      if (openPort == null) {
        throw new Error(
          'IB Gateway not reachable on port 4002/7497. Launch IB Gateway Desktop in Paper mode ' +
            '(Enable ActiveX and Socket Clients; uncheck Read-Only API). No browser will be opened.',
        );
      }
    } else if (resolvedId === 'ibkr_web') {
      let health: string;
      try {
        health = await broker.health();
      } catch (e: any) {
        throw new Error(
          `IBKR Client Portal Web API not reachable on port 5000. Start Client Portal Gateway and complete browser login only for ibkr_web. (${e?.message || e})`,
        );
      }
      if (health === 'Offline') {
        throw new Error(
          'IBKR Client Portal Web API offline (port 5000). Start the Gateway and log in via browser, or use ibkr_gateway (socket :4002) instead.',
        );
      }
    }

    if (this.activeBroker && this.activeBroker.id !== resolvedId) {
      console.log(`[BrokerManager] Switching from ${this.activeBroker.name} to ${broker.name}`);
      try {
        await this.activeBroker.disconnect();
      } catch (e) {
        logErrorSafely('[BrokerManager] Failed to disconnect previous broker safely', e);
      }
    }

    const connected = await broker.authenticate(authPayload);
    if (connected) {
      this.activeBroker = broker;
      const stampPaper = paperOnly || authPayload.isLive !== true;
      await this.ensureBrokerConnectionPaperStamp(broker, stampPaper);
      await this.applyMarketDataBinding(broker);
      console.log(`[BrokerManager] Active broker is now ${broker.name} (id=${resolvedId}, paperOnly=${paperOnly}, paperMode=${stampPaper})`);
      // Fail-closed cutover: drop prior adapter's local holdings, then live-reconcile.
      try {
        const { portfolioReconciliationWorker } = await import('../server/services/PortfolioReconciliation');
        await portfolioReconciliationWorker.flushLocalHoldingsAndReconcile(`setActiveBroker→${resolvedId}`);
      } catch (e) {
        logErrorSafely('[BrokerManager] Post-switch portfolio flush/reconcile failed (non-fatal)', e);
      }
      return true;
    }

    if (resolvedId === 'ibkr_gateway') {
      throw new Error(
        'IB Gateway socket authenticate() failed — ensure Desktop Gateway is running on 4002 with API clients enabled.',
      );
    }
    if (resolvedId === 'ibkr_web') {
      throw new Error(
        'IBKR Web API authenticate() failed — Client Portal may need browser login (HTTP 401). Argus will not auto-open a browser.',
      );
    }
    if (resolvedId === 'alpaca') {
      throw new Error(
        'Alpaca authenticate() failed — check paper API keys (ALPACA_* or Broker settings) and paper host.',
      );
    }
    throw new Error(`Failed to authenticate broker '${broker.name}' (${resolvedId}).`);
  }

  /**
   * Stamp brokerConnections.paperMode so OMS classifyBrokerEnvironment stays PAPER
   * after ibkr_gateway cutover (dual paper+live capabilities must not leave paperMode null).
   */
  private async ensureBrokerConnectionPaperStamp(broker: BrokerPlugin, paper: boolean): Promise<void> {
    try {
      const existing = await db.select().from(schema.brokerConnections).where(eq(schema.brokerConnections.brokerName, broker.name));
      if (existing.length > 0) {
        await db.update(schema.brokerConnections).set({ paperMode: paper }).where(eq(schema.brokerConnections.brokerName, broker.name));
      } else {
        await db.insert(schema.brokerConnections).values({ brokerName: broker.name, paperMode: paper });
      }
    } catch (e) {
      logErrorSafely('[BrokerManager] Failed to stamp brokerConnections.paperMode', e);
    }
  }

    /** Rebind MarketDataWorker quote backend after a successful active-broker switch. */
  private async applyMarketDataBinding(broker: BrokerPlugin): Promise<void> {
    try {
      const { marketDataWorker } = await import('../server/services/MarketDataWorker');
      const { loadIbkrConnection } = await import('../server/config/ibkrConnection');
      const { registerHistoricalBarProvider } = await import('../server/engines/backtest/historicalBarProvider');
      if (broker.id === 'ibkr_gateway' && broker instanceof IBGatewaySocketAdapter) {
        const cfg = loadIbkrConnection();
        broker.setQuoteSink((symbol, price) => marketDataWorker.ingestIbkrQuote(symbol, price));
        marketDataWorker.setBrokerQuoteContext({
          backend: 'ibkr_gateway',
          hardCapOverride: cfg.maxMarketDataLines,
          ibkrBridge: {
            subscribe: (sym) => broker.subscribeMarketData(sym),
            unsubscribe: (sym) => broker.cancelMarketDataBySymbol(sym),
            clear: () => {
              broker.setQuoteSink(null);
            },
            isConnected: () => broker.isMarketDataSessionConnected(),
          },
        });
        // Quant / HistoricalDataGateway: IB reqHistoricalData — no Alpaca REST while gateway is active.
        registerHistoricalBarProvider({
          id: 'ibkr_gateway',
          fetchBars: (symbol, timeframe, startMs, endMs) =>
            broker.getHistoricalBars(symbol, timeframe, startMs, endMs),
        });
      } else {
        marketDataWorker.setBrokerQuoteContext({
          backend: 'alpaca',
          hardCapOverride: null,
          ibkrBridge: null,
        });
        registerHistoricalBarProvider(null);
      }
    } catch (e) {
      logErrorSafely('[BrokerManager] MarketDataWorker rebind failed (non-fatal)', e);
    }
  }

  /** Dual IBKR path status for ./argus health — never opens a browser. */
  public async getIbkrPathStatus(): Promise<{
    gatewaySocket: { port: number; status: string; accountId?: string | null };
    webApi: { port: number; status: string };
  }> {
    const { loadIbkrConnection, ibkrSocketPortCandidates } = await import('../server/config/ibkrConnection');
    const { findFirstOpenTcpPort, probeTcpPort } = await import('./ibkrTcpProbe');
    const cfg = loadIbkrConnection();
    const socketPort = await findFirstOpenTcpPort(cfg.host, ibkrSocketPortCandidates(cfg, false), 1200);
    const gateway = this.brokers.get('ibkr_gateway') as IBGatewaySocketAdapter | undefined;
    let gatewayStatus = socketPort == null ? 'OFFLINE' : 'CONNECTED';
    let accountId: string | null | undefined;
    if (gateway && typeof gateway.getConnectionSnapshot === 'function') {
      const snap = gateway.getConnectionSnapshot();
      if (snap.authenticated) {
        gatewayStatus = 'CONNECTED';
        accountId = snap.accountId as string | null;
      } else if (socketPort != null) {
        gatewayStatus = 'CONNECTED';
      }
    }
    const webOpen = await probeTcpPort('127.0.0.1', 5000, 1200);
    let webStatus = webOpen ? 'CONNECTED' : 'OFFLINE';
    const web = this.brokers.get('ibkr_web');
    if (web) {
      try {
        const h = await web.health();
        if (h === 'Healthy') webStatus = 'CONNECTED';
        else if (h === 'Degraded') webStatus = '401_AUTH_REQUIRED';
        else if (!webOpen) webStatus = 'OFFLINE';
        else webStatus = '401_AUTH_REQUIRED';
      } catch {
        webStatus = webOpen ? '401_AUTH_REQUIRED' : 'OFFLINE';
      }
    }
    return {
      gatewaySocket: { port: socketPort ?? cfg.paperGatewayPort, status: gatewayStatus, accountId },
      webApi: { port: 5000, status: webStatus },
    };
  }

  public getActiveBroker(): BrokerPlugin {
    const replay = getActiveReplaySession();
    if (replay?.broker) return replay.broker;
    return this.activeBroker;
  }

  // Read-only lookup of a specific registered broker by id, regardless of which one is active -
  // for consumers (e.g. MarketDataCrossChecker) that need a specific broker's real capability
  // (Questrade's read-only market data) without disturbing which broker is set to place orders.
  // Never creates a second instance - reusing this one matters for Questrade specifically, since
  // its refresh token is single-use and a second independent authenticate() call would break it.
  public getBroker(id: string): BrokerPlugin | undefined {
    return this.brokers.get(id);
  }

  // Real connection test that never mutates the active broker - calls the adapter's own
  // authenticate() and health() and reports exactly what came back, including the real error
  // message on failure. Previously SetupWizard.tsx's connection tests were mocked client-side;
  // this is the real backend counterpart for any UI that wants a genuine test.
  //
  // Deliberately does NOT short-circuit for NON_FUNCTIONAL_BROKER_IDS here (unlike
  // setActiveBroker/setLiveMode) - Questrade's placeOrder() is permanently impossible for a
  // retail app, but its authenticate()/health() are now a real OAuth exchange + API call, and a
  // user configuring QUESTRADE_REFRESH_TOKEN has a real reason to want to know whether it
  // actually works. The response still says plainly that order placement is unavailable
  // regardless of how the connection test itself comes out.
  public async testConnection(id: string, credentials?: any): Promise<{ ok: boolean; health: string; error?: string; note?: string }> {
    const broker = this.brokers.get(id);
    if (!broker) return { ok: false, health: 'Offline', error: `Broker '${id}' not found` };
    try {
      const authenticated = await broker.authenticate(credentials);
      const health = await broker.health();
      const note = NON_FUNCTIONAL_BROKER_IDS.has(id)
        ? `Connection test only - ${broker.name}'s order-execution API is not available to retail apps, regardless of this result.`
        : undefined;
      return { ok: authenticated, health, note };
    } catch (e: any) {
      return { ok: false, health: 'Offline', error: e.message };
    }
  }

  // The only path in the app that can put a broker connection into real-money live mode.
  // brokerConnections.paperMode defaults to true and nothing else in the codebase ever set it to
  // false - there was no live-trading promotion path at all, reachable or not. Requires the
  // caller to echo back LIVE_TRADING_CONFIRMATION_PHRASE exactly; going back to paper mode never
  // requires confirmation, since that direction is always safe.
  public async setLiveMode(id: string, live: boolean, confirmationPhrase?: string): Promise<{ ok: boolean; error?: string }> {
    const broker = this.brokers.get(id);
    if (!broker) return { ok: false, error: `Broker '${id}' not found` };
    if (live && process.env.PAPER_TRADING_ONLY === 'true') {
      throw new Error('Cannot enable LIVE mode when PAPER_TRADING_ONLY is enforced in environment.');
    }
    if (live && NON_FUNCTIONAL_BROKER_IDS.has(id)) {
      return { ok: false, error: `${broker.name}'s placeOrder() is unimplemented - it can never trade live regardless of confirmation.` };
    }
    // Capability-gated, not just the functional/non-functional split above: a broker can place
    // orders but still lack ONE of the two modes specifically (Coinbase has no paper/sandbox
    // environment at all; the Internal Paper Simulator has no real account behind it to go live).
    // Without this check, a client could set a mode the adapter's own placeOrder()/authenticate()
    // would later refuse anyway - this fails clearly upfront instead of at order time.
    const caps = broker.getCapabilities();
    if (live && !caps.liveTrading) {
      return { ok: false, error: `${broker.name} does not support live trading.` };
    }
    if (!live && !caps.paperTrading) {
      return { ok: false, error: `${broker.name} does not support paper trading (no sandbox/simulated environment exists for this broker).` };
    }
    if (live && confirmationPhrase !== LIVE_TRADING_CONFIRMATION_PHRASE) {
      return { ok: false, error: `Enabling live trading on ${broker.name} requires the exact confirmation phrase "${LIVE_TRADING_CONFIRMATION_PHRASE}".` };
    }
    if (live && !armLiveTrading(confirmationPhrase)) {
      return { ok: false, error: `Enabling live trading on ${broker.name} requires the exact confirmation phrase "${LIVE_TRADING_CONFIRMATION_PHRASE}".` };
    }
    if (!live) disarmLiveTrading();

    const existing = await db.select().from(schema.brokerConnections).where(eq(schema.brokerConnections.brokerName, broker.name));
    if (existing.length > 0) {
      await db.update(schema.brokerConnections).set({ paperMode: !live }).where(eq(schema.brokerConnections.brokerName, broker.name));
    } else {
      await db.insert(schema.brokerConnections).values({ brokerName: broker.name, paperMode: !live });
    }

    if (this.activeBroker.id === id) {
      if (live) this.activeBroker.liveTrading(); else this.activeBroker.paperTrading();
    }

    console.warn(`[BrokerManager] ${broker.name} switched to ${live ? 'LIVE (real money)' : 'paper'} mode.`);
    return { ok: true };
  }

  public getAvailableBrokers(): {id: string, name: string, capabilities: ReturnType<BrokerPlugin['getCapabilities']>}[] {
    return Array.from(this.brokers.values()).map(b => ({
      id: b.id,
      name: b.name,
      capabilities: b.getCapabilities()
    }));
  }
  
  /** InternalPaper fills use MarketDataWorker IEX quotes (EventBus MARKET_DATA), not a second socket. */
  private wireInternalPaperTicksFromMarketData() {
    if (this.paperTickFromMarketData) return;
    this.paperTickFromMarketData = true;
    eventBus.on(EVENTS.MARKET_DATA, (payload: { symbol?: string; price?: number }) => {
      const symbol = payload?.symbol;
      const price = payload?.price;
      if (typeof symbol === 'string' && typeof price === 'number' && Number.isFinite(price) && price > 0) {
        this.tick({ [symbol]: price });
      }
    });
  }

  public tick(prices: Record<string, number>) {
     if (this.activeBroker.tick) {
        this.activeBroker.tick(prices);
     }
  }
}
