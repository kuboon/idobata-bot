/**
 * The database outside a Worker: a local SQLite file (or memory), migrated on open.
 *
 * Deno-only — `@remix-kbn/data-table-d1/node` is `node:sqlite` — so only `router.tsx` and the tests
 * import this, never `worker.ts`. The Worker's D1 is migrated ahead of a deploy with
 * `deno task db migrate --remote`; here the migrations run on every open, because a fresh
 * in-memory database is what most opens are.
 *
 * It also refuses statements D1 would refuse for binding more than {@link D1_MAX_PARAMS}
 * parameters, so the dev server and the tests fail where Cloudflare would.
 */

import { createLocalD1 } from "@remix-kbn/data-table-d1/node";
import { loadMigrations } from "@remix-run/data-table/migrations/node";

import type { D1DatabaseBinding } from "@remix-kbn/data-table-d1";

import { D1_MAX_PARAMS, type Db, useDatabase } from "./mod.ts";

/** `db/migrations` at the repository root — the directory `deno task db` reads too. */
const MIGRATIONS_DIR = new URL("../../../db/migrations", import.meta.url);

/**
 * Opens a local database, applies every migration, and makes it the app's database.
 *
 * @param filename A SQLite file path, or `":memory:"` for a throwaway database
 * @returns The migrated database
 */
export async function openLocalDatabase(filename: string): Promise<Db> {
  const db = useDatabase(withD1ParamLimit(await createLocalD1(filename)));
  await db.migrate(
    await loadMigrations(decodeURIComponent(MIGRATIONS_DIR.pathname)),
  );
  return db;
}

/** A binding that throws, as D1 does, on a statement binding more than {@link D1_MAX_PARAMS}. */
function withD1ParamLimit(binding: D1DatabaseBinding): D1DatabaseBinding {
  return {
    prepare(query) {
      const statement = binding.prepare(query);
      return {
        ...statement,
        bind(...values) {
          if (values.length > D1_MAX_PARAMS) {
            throw new Error(
              `too many SQL variables: ${values.length} > ${D1_MAX_PARAMS} (D1's limit)`,
            );
          }
          return statement.bind(...values);
        },
        all: () => statement.all(),
      };
    },
    batch: (statements) => binding.batch(statements),
  };
}
