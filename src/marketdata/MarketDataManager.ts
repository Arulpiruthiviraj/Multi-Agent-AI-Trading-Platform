/**
 * ==========================================================
 * Module:
 * MarketDataManager.ts
 *
 * Purpose:
 * Core implementation and logic for the MarketDataManager.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for MarketDataManager
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

import { MarketDataAdapter } from './MarketDataAdapter';
import { PolygonAdapter } from './PolygonAdapter';
import { YahooFinanceAdapter } from './YahooFinanceAdapter';

export class MarketDataManager {
  private static instance: MarketDataManager;
  private adapters: Map<string, MarketDataAdapter> = new Map();
  private activeAdapter: MarketDataAdapter;

  private constructor() {
    this.adapters.set('polygon', new PolygonAdapter());
    this.adapters.set('yfinance', new YahooFinanceAdapter());
    this.activeAdapter = this.adapters.get('yfinance')!;
  }

  public static getInstance(): MarketDataManager {
    if (!MarketDataManager.instance) {
      MarketDataManager.instance = new MarketDataManager();
    }
    return MarketDataManager.instance;
  }

  public getAvailableAdapters() {
    return Array.from(this.adapters.values()).map(a => ({ id: a.id, name: a.name }));
  }

  public getActiveAdapter(): MarketDataAdapter {
    return this.activeAdapter;
  }

  public async setActiveAdapter(id: string, credentials?: any): Promise<boolean> {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error("Market data adapter not found");
    
    const success = await adapter.connect(credentials);
    if (success) {
      this.activeAdapter = adapter;
    }
    return success;
  }
}
