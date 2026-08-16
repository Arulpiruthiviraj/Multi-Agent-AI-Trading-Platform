/**
 * `npm run db:migrate` — applies drizzle/ SQL via the same migrator as process boot.
 * Importing src/server/db/index.ts runs migrate() and refuses to continue on failure.
 */
import '../src/server/db/index.ts';
console.log('[db:migrate] Applied (src/server/db/index.ts migrator).');
