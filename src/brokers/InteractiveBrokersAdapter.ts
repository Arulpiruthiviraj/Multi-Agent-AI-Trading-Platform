/**
 * ==========================================================
 * Module: InteractiveBrokersAdapter
 *
 * Compatibility facade:
 * - String URL / mode=web_api → InteractiveBrokersWebApiAdapter (id ibkr_web)
 * - Default → IBGatewaySocketAdapter (id ibkr_gateway)
 *
 * BrokerManager registers both adapters separately. Prefer selecting
 * `ibkr_gateway` / `ibkr_web` / auto alias `ibkr` via setActiveBroker.
 * ==========================================================
 */
import { BrokerPlugin, BrokerCapabilities, Order, Position, Portfolio } from './BrokerAdapter';
import { loadIbkrConnection, type IbkrConnectionMode } from '../server/config/ibkrConnection';
import { IBGatewaySocketAdapter } from './IBGatewaySocketAdapter';
import { InteractiveBrokersWebApiAdapter } from './InteractiveBrokersWebApiAdapter';

export type InteractiveBrokersAdapterOptions = {
  mode?: IbkrConnectionMode;
  baseUrl?: string;
};

export class InteractiveBrokersAdapter implements BrokerPlugin {
  /** Alias id kept for older UI rows — prefer ibkr_gateway / ibkr_web. */
  id = 'ibkr';
  name = 'Interactive Brokers';

  private inner: BrokerPlugin;
  private mode: IbkrConnectionMode;

  constructor(baseUrlOrOpts?: string | InteractiveBrokersAdapterOptions) {
    if (typeof baseUrlOrOpts === 'string') {
      this.mode = 'web_api';
      this.inner = new InteractiveBrokersWebApiAdapter(baseUrlOrOpts);
      this.id = 'ibkr_web';
      this.name = this.inner.name;
    } else if (baseUrlOrOpts?.baseUrl || baseUrlOrOpts?.mode === 'web_api') {
      this.mode = 'web_api';
      this.inner = new InteractiveBrokersWebApiAdapter(baseUrlOrOpts.baseUrl);
      this.id = 'ibkr_web';
      this.name = this.inner.name;
    } else {
      const cfg = loadIbkrConnection();
      this.mode = baseUrlOrOpts?.mode || cfg.mode;
      if (this.mode === 'web_api') {
        this.inner = new InteractiveBrokersWebApiAdapter(cfg.webApiGatewayUrlDefault);
        this.id = 'ibkr_web';
        this.name = this.inner.name;
      } else {
        this.inner = new IBGatewaySocketAdapter();
        this.id = 'ibkr_gateway';
        this.name = this.inner.name;
      }
    }
  }

  getConnectionSnapshot(): Record<string, unknown> {
    if (typeof (this.inner as any).getConnectionSnapshot === 'function') {
      return (this.inner as any).getConnectionSnapshot();
    }
    return { mode: this.mode, adapter: this.id };
  }

  async initialize(): Promise<void> {
    return this.inner.initialize();
  }
  getCapabilities(): BrokerCapabilities {
    return this.inner.getCapabilities();
  }
  async health(): Promise<string> {
    return this.inner.health();
  }
  async authenticate(credentials?: any): Promise<boolean> {
    return this.inner.authenticate(credentials);
  }
  async validateCredentials(): Promise<boolean> {
    return this.inner.validateCredentials();
  }
  paperTrading(): void {
    this.inner.paperTrading();
  }
  liveTrading(): void {
    this.inner.liveTrading();
  }
  async disconnect(): Promise<void> {
    return this.inner.disconnect();
  }
  async account(): Promise<any> {
    return this.inner.account();
  }
  async portfolio(): Promise<Portfolio> {
    return this.inner.portfolio();
  }
  async positions(): Promise<Position[]> {
    return this.inner.positions();
  }
  async orders(): Promise<Order[]> {
    return this.inner.orders();
  }
  async placeOrder(order: Partial<Order>): Promise<Order> {
    return this.inner.placeOrder(order);
  }
  async cancelOrder(orderId: string): Promise<boolean> {
    return this.inner.cancelOrder(orderId);
  }
  async closePosition(symbol: string): Promise<boolean> {
    return this.inner.closePosition(symbol);
  }
}
