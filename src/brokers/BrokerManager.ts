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
import { InteractiveBrokersAdapter } from './InteractiveBrokersAdapter';
import { CoinbaseBroker } from './CoinbaseBroker';
import { BrokerPlugin } from './BrokerAdapter';
import { InternalPaperBroker } from './InternalPaperBroker';
import { AlpacaBroker } from './AlpacaBroker';
import { db } from '../server/db';
import * as schema from '../server/db/schema';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../server/core/EncryptionService';
import { LIVE_TRADING_CONFIRMATION_PHRASE } from '../server/core/LiveTradingConfirmation';

// placeOrder() throws 'Not implemented' on every one of these - confirmed non-functional stubs,
// not partial implementations. Never allow them to become the active (order-placing) broker.
// ibkr was moved off this list once InteractiveBrokersAdapter got a real Client Portal Web API
// implementation - it can still legitimately fail authenticate() (requiresManualReauth: true,
// no Gateway running), which is a real runtime state, not a stub. coinbase was moved off this
// list once CoinbaseBroker got a real Advanced Trade API implementation (order placement gated
// behind live-mode confirmation, since Coinbase has no paper/sandbox environment to fall back to
// - see CoinbaseBroker.ts's header comment). questrade remains here permanently, not because it's
// unimplemented but because Questrade's own API restricts order execution to approved partner
// developers - no implementation here can change that.
const NON_FUNCTIONAL_BROKER_IDS = new Set(['questrade']);

export class BrokerManager {
  private static instance: BrokerManager;
  private activeBroker: BrokerPlugin;
  private brokers: Map<string, BrokerPlugin> = new Map();

  private constructor() {
     // A dummy initialization, will be overwritten by initialize()
     this.activeBroker = new InternalPaperBroker();
  }

  public static getInstance(): BrokerManager {
    if (!BrokerManager.instance) {
      BrokerManager.instance = new BrokerManager();
    }
    return BrokerManager.instance;
  }
  
  public async initialize() {
     try {
         const internalPaper = new InternalPaperBroker();
         const alpaca = new AlpacaBroker();
         const questrade = new QuestradeBroker();
         const ibkr = new InteractiveBrokersAdapter();
         const coinbase = new CoinbaseBroker();
         
         this.brokers.set(internalPaper.id, internalPaper);
         this.brokers.set(alpaca.id, alpaca);
         this.brokers.set(questrade.id, questrade);
         this.brokers.set(ibkr.id, ibkr);
         this.brokers.set(coinbase.id, coinbase);
         
         // Initialize plugins
         for (const broker of this.brokers.values()) {
             await broker.initialize();
         }
         
         const settings = await db.select().from(schema.settings).limit(1);
         const selectedName = settings[0]?.selectedBroker || 'Simulation Mode';

         const brokerConnections = await db.select().from(schema.brokerConnections);

         let activeFound = false;

         for (const [id, broker] of this.brokers.entries()) {
             if (NON_FUNCTIONAL_BROKER_IDS.has(id)) continue;
             if (broker.name === selectedName || (selectedName === 'Simulation Mode' && id === 'internal_paper')) {
                 this.activeBroker = broker;
                 activeFound = true;
                 break;
             }
         }

         if (!activeFound) {
             console.warn(`[BrokerManager] Saved broker selection '${selectedName}' is unavailable or non-functional. Falling back to Internal Paper Simulator.`);
             this.activeBroker = internalPaper;
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
             const key = connection.apiKeyEncrypted ? EncryptionService.decrypt(connection.apiKeyEncrypted) : undefined;
             const secret = connection.secretEncrypted ? EncryptionService.decrypt(connection.secretEncrypted) : undefined;

             if (connection.paperMode) {
                 this.activeBroker.paperTrading();
             } else {
                 this.activeBroker.liveTrading();
             }

             await this.activeBroker.authenticate({ apiKey: key, secretKey: secret });
         } else if (this.activeBroker.id === 'alpaca') {
             // No DB connection row yet - Alpaca is the one adapter designed to fall back to
             // process.env.ALPACA_API_KEY/SECRET_KEY on its own when given no credentials.
             await this.activeBroker.authenticate({});
         } else {
             await this.activeBroker.authenticate({ initialCash: 100000 });
         }
         
         console.log(`[BrokerManager] Initialized with Active Broker: ${this.activeBroker.name}`);
     } catch (e) {
         console.error('[BrokerManager] Init Failed', e);
     }
  }

  public registerBroker(broker: BrokerPlugin) {
    this.brokers.set(broker.id, broker);
  }

  public async setActiveBroker(id: string, credentials?: any): Promise<boolean> {
    const broker = this.brokers.get(id);
    if (!broker) throw new Error(`Broker ${id} not found`);
    if (NON_FUNCTIONAL_BROKER_IDS.has(id)) {
      throw new Error(`Broker '${broker.name}' is not a functional adapter (placeOrder is unimplemented). Refusing to select it as active.`);
    }

    // Safe transition
    if (this.activeBroker && this.activeBroker.id !== id) {
      console.log(`[BrokerManager] Switching from ${this.activeBroker.name} to ${broker.name}`);
      try {
        await this.activeBroker.disconnect();
      } catch (e) {
        console.error("Failed to disconnect previous broker safely", e);
      }
    }

    const connected = await broker.authenticate(credentials);
    if (connected) {
      this.activeBroker = broker;
      return true;
    }
    return false;
  }

  public getActiveBroker(): BrokerPlugin {
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
  
  // Tick for simulated paper brokers
  public tick(prices: Record<string, number>) {
     if (this.activeBroker.tick) {
        this.activeBroker.tick(prices);
     }
  }
}
