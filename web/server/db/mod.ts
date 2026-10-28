/**
 * The app's database handle, set once by whichever entry point is running.
 *
 * The database is a D1 binding on Cloudflare and a local SQLite file under Deno, and the two are
 * opened by different code that must not meet: `@remix-kbn/data-table-d1/node` imports
 * `node:sqlite`, which cannot be bundled into the Worker. So neither is opened here. `worker.ts`
 * calls {@link useDatabase} with `env.DB` on its first request, `router.tsx` with a local file,
 * and tests with an in-memory one — and everything else reads it back with {@link getDb}.
 */

import {
  createD1Database,
  type D1BackedDatabase,
  type D1DatabaseBinding,
} from "@remix-kbn/data-table-d1";

export type Db = D1BackedDatabase;

let current: Db | undefined;

/**
 * Sets the database every request uses from now on.
 *
 * @param binding A D1 binding: `env.DB` in the Worker, `createLocalD1()` elsewhere
 * @returns The database built on it
 */
export function useDatabase(binding: D1DatabaseBinding): Db {
  current = createD1Database(binding);
  return current;
}

/**
 * The database {@link useDatabase} set.
 *
 * @returns The database
 * @throws When no entry point has set one, which is a wiring bug rather than a request error
 */
export function getDb(): Db {
  if (!current) {
    throw new Error(
      "No database: call useDatabase() from the entry point first.",
    );
  }
  return current;
}
