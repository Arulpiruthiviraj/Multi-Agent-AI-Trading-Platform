import { describe, it, expect } from 'vitest';
import { AlpacaRequestError } from '../../brokers/AlpacaBroker';
import { brokerPortfolioError, withTimeout } from './brokerPortfolioResponse';

describe('brokerPortfolioError', () => {
  it('maps circuit-open and timeout to 503 with available:false and no invented equity', () => {
    const circuit = brokerPortfolioError(new AlpacaRequestError('breaker open', 'CIRCUIT_OPEN'));
    expect(circuit.status).toBe(503);
    expect(circuit.body.available).toBe(false);
    expect(circuit.body).not.toHaveProperty('equity');
    expect(circuit.body).not.toHaveProperty('cash');
    expect(circuit.body.reason).toContain('breaker open');

    const timeout = brokerPortfolioError(new AlpacaRequestError('timed out', 'TIMEOUT'));
    expect(timeout.status).toBe(503);
  });

  it('maps generic throws to 502 without fabricating a book', () => {
    const mapped = brokerPortfolioError(new Error('fetch failed'));
    expect(mapped.status).toBe(502);
    expect(mapped.body.available).toBe(false);
    expect(mapped.body.error).toMatch(/Broker unavailable: fetch failed/);
  });
});

describe('withTimeout', () => {
  it('rejects when the inner promise does not settle in time', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'broker.portfolio()')).rejects.toThrow(
      /timed out after 20ms/,
    );
  });

  it('resolves the inner value when it finishes first', async () => {
    await expect(withTimeout(Promise.resolve({ equity: 1 }), 50, 'broker.portfolio()')).resolves.toEqual({
      equity: 1,
    });
  });
});
