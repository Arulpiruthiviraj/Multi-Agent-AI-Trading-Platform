/**
 * Load a JSON file from the repo `config/` directory (dev, vitest, and bundled server).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadRepoConfigJson<T>(fileName: string): T {
  const candidates = [
    join(process.cwd(), 'config', fileName),
    join(dirname(fileURLToPath(import.meta.url)), '../../../config', fileName),
    join(dirname(fileURLToPath(import.meta.url)), '../../config', fileName),
    join(dirname(fileURLToPath(import.meta.url)), '../config', fileName),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    }
  }
  throw new Error(`config/${fileName} not found. Tried: ${candidates.join('; ')}`);
}
