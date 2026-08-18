import crypto from 'crypto';
import { observabilityConfig } from '../config/observability';

/** SHA-256 hex prefix for prompts/tokens — never log the raw secret. */
export function hashSensitive(value: string | null | undefined): string | null {
  if (!value) return null;
  const n = observabilityConfig.promptHashLength;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, n);
}
