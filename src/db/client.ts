import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

/** Bounds on every query this pool runs.
 *
 * `lock_timeout` is the important one. A migration waiting for ACCESS
 * EXCLUSIVE parks every transaction that arrives after it, so without a
 * bound an ordinary SELECT inherits the migration's entire wait — which is
 * how a schema change on journey_stops took the home page down while
 * routes that did not read that table stayed up. Two seconds is far above
 * any lock this app takes in normal operation and far below the proxy's
 * patience, so it only ever fires when something is genuinely stuck.
 *
 * `statement_timeout` is the backstop for a query that acquires its locks
 * and then runs away. The slowest legitimate read is a cold entity
 * aggregate at a few seconds, so 30 s is generous.
 *
 * Migrations deliberately do NOT use this pool: they need to hold a lock
 * far longer than any reader should. See migrationsApplied in workers.ts. */
export const sql = postgres(url, {
	connection: { lock_timeout: 2_000, statement_timeout: 30_000 },
});
export const db = drizzle({ client: sql, schema });
export type Db = typeof db;
