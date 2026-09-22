/**
 * ARGUS Crypto V2 - mechanical production-pollution guard (2026-09-21 P0 slice). A pure,
 * side-effect-free validator, not a live safety control itself - the REAL safety guarantee is
 * structural: nothing in the live spine imports src/server/crypto/synthetic/ at all (see
 * syntheticCryptoArchitectureBoundary.test.ts). This function exists so any FUTURE integration
 * point (a synthetic broker, a database writer) has one shared, testable place to assert the
 * invariant explicitly, rather than each new caller hand-rolling its own check - per the mandate's
 * own instruction: "If any invariant is violated: FAIL LOUDLY. Do not silently redirect."
 */

const SYNTHETIC_SYMBOL_PREFIX = 'SYN';

/** Throws if `symbol` is not mechanically distinguishable as synthetic. Every symbol this
 *  package's generators produce satisfies this by construction (see
 *  SyntheticCryptoPopulationGenerator.ts) - this function is the enforcement point a future
 *  synthetic broker/OMS integration must call before accepting an order for a "synthetic" symbol. */
export function assertSyntheticSymbol(symbol: string): void {
  if (!symbol.startsWith(SYNTHETIC_SYMBOL_PREFIX)) {
    throw new Error(
      `PRODUCTION_POLLUTION_GUARD: symbol "${symbol}" is not a synthetic symbol (must start with "${SYNTHETIC_SYMBOL_PREFIX}"). ` +
        'A synthetic pipeline must never accept a symbol that could be a real listed ticker.',
    );
  }
}

/** Throws if `dbPath` looks like it could be the real production database. Real production paths
 *  in this codebase resolve to data/argus.db (see drizzle.config.ts); a synthetic run must use an
 *  isolated path such as data/argus-synthetic/. */
export function assertNotProductionDatabasePath(dbPath: string): void {
  const normalized = dbPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.endsWith('data/argus.db') || normalized === 'argus.db') {
    throw new Error(
      `PRODUCTION_POLLUTION_GUARD: refusing to use production database path "${dbPath}" for a synthetic run. ` +
        'Use an isolated path (e.g. data/argus-synthetic/).',
    );
  }
}

/** Throws unless `filePath` sits under the isolated data/argus-synthetic/ directory - the
 *  required home for any synthetic experiment/registry file, mirroring the mandate's own
 *  "data/argus-synthetic/... never write synthetic results into production organic paper
 *  tables" instruction, generalized from SQLite to any file-based synthetic artifact. */
export function assertSyntheticArtifactPath(filePath: string): void {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (!normalized.includes('data/argus-synthetic/')) {
    throw new Error(
      `PRODUCTION_POLLUTION_GUARD: refusing to write synthetic artifact outside data/argus-synthetic/ (got "${filePath}").`,
    );
  }
}
