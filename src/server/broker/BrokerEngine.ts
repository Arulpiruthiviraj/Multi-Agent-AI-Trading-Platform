/**
 * ==========================================================
 * Module: BrokerEngine.ts
 * Purpose: Manages broker plugins and routes orders.
 * ==========================================================
 */
import { BrokerPlugin, OrderRequest, OrderResult } from './BrokerPlugin';
import EventBus from '../core/EventBus';

class BrokerEngine {
  private static instance: BrokerEngine;
  private activeBroker: BrokerPlugin | null = null;
  private brokers: Map<string, BrokerPlugin> = new Map();

  private constructor() {}

  public static getInstance(): BrokerEngine {
    if (!BrokerEngine.instance) {
      BrokerEngine.instance = new BrokerEngine();
    }
    return BrokerEngine.instance;
  }

  public registerBroker(broker: BrokerPlugin) {
    this.brokers.set(broker.name, broker);
    EventBus.publish('BROKER_REGISTERED', { brokerName: broker.name });
  }

  public async setActiveBroker(brokerName: string, credentials: any): Promise<boolean> {
    const broker = this.brokers.get(brokerName);
    if (!broker) return false;

    if (this.activeBroker) {
      await this.activeBroker.disconnect();
    }

    const connected = await broker.connect(credentials);
    if (connected) {
      this.activeBroker = broker;
      EventBus.publish('BROKER_CONNECTED', { brokerName });
      return true;
    }
    return false;
  }

  public getActiveBroker(): BrokerPlugin | null {
    return this.activeBroker;
  }

  public async getQuote(symbol: string) {
    if (!this.activeBroker) return null;
    return this.activeBroker.getQuote(symbol);
  }

  public async submitOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.activeBroker) {
      return {
        orderId: 'offline',
        status: 'REJECTED',
        timestamp: new Date().toISOString(),
        error: 'No active broker connected'
      };
    }
    const result = await this.activeBroker.submitOrder(order);
    EventBus.publish(result.status === 'FILLED' ? 'ORDER_EXECUTED' : 'ORDER_REJECTED', result);
    return result;
  }
}

export default BrokerEngine.getInstance();
