/**
 * The database outside a Worker: a local SQLite file (or memory), migrated on open.
 *
 * Deno-only — `@remix-kbn/data-table-d1/node` is `node:sqlite` — so only `router.tsx` and the tests
 * import this, never `worker.ts`. The Worker's D1 is migrated ahead of a deploy with
 * `deno task db migrate --remote`; here the migrations run on every open, because a fresh
 * in-memory database is what most opens are.
 */

import { createLocalD1 } from "@remix-kbn/data-table-d1/node";
import { loadMigrations } from "@remix-run/data-table/migrations/node";

import { type Db, useDatabase } from "./mod.ts";

/** `db/migrations` at the repository root — the directory `deno task db` reads too. */
const MIGRATIONS_DIR = new URL("../../../db/migrations", import.meta.url);

/**
 * Opens a local database, applies every migration, and makes it the app's database.
 *
 * @param filename A SQLite file path, or `":memory:"` for a throwaway database
 * @returns The migrated database
 */
export async function openLocalDatabase(filename: string): Promise<Db> {
  const db = useDatabase(await createLocalD1(filename));
  await db.migrate(
    await loadMigrations(decodeURIComponent(MIGRATIONS_DIR.pathname)),
  );
  return db;
}
