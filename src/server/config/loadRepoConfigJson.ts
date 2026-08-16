/**
 * Load a JSON file from the repo `config/` directory (dev, vitest, and bundled server).
 */
import { configJsonCandidates, readFirstExistingJson } from './repoPaths';

export function loadRepoConfigJson<T>(fileName: string): T {
  return readFirstExistingJson<T>(configJsonCandidates(fileName), `config/${fileName}`);
}
