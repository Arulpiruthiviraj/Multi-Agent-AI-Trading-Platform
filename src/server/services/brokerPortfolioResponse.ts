/**
 * Structured GET /api/v1/portfolio error mapping.
 * Never invents cash/equity. Fail-closed: 502/503 + available:false.
 */
import { AlpacaRequestError } from '../../brokers/AlpacaBroker';

export type BrokerPortfolioErrorBody = {
  available: false;
  error: string;
  reason: string;
};

export function brokerPortfolioError(err: unknown): { status: 502 | 503; body: BrokerPortfolioErrorBody } {
  const message = err instanceof Error ? err.message : String(err ?? 'unknown broker error');
  const kind = err instanceof AlpacaRequestError ? err.kind : undefined;
  const status: 502 | 503 =
    kind === 'CIRCUIT_OPEN' || kind === 'TIMEOUT' ? 503 : 502;
  return {
    status,
    body: {
      available: false,
      error: `Broker unavailable: ${message}`,
      reason: message,
    },
  };
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
