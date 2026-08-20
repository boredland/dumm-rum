import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

/** Backstop against a query that has stopped making progress.
 *
 * There is deliberately no lock_timeout here. One was added while chasing an
 * outage caused by a migration that rewrote journey_stops: a pending ACCESS
 * EXCLUSIVE request parks every reader behind it, so reads were inheriting
 * that unbounded wait. But the bound cured nothing and caused its own
 * failures — at 2 s, then 10 s, then 20 s it aborted ordinary reads that were
 * merely queued behind ingest writes, turning a slow page into a broken one.
 *
 * The real fix was removing the rewrite. With no migration taking a long
 * exclusive lock, no reader has an unbounded wait to inherit, and a lock this
 * app does take is one it should simply wait for.
 *
 * statement_timeout stays, high. It is not a performance budget — the SWR
 * layer keeps the heavy aggregates off the request path — just a ceiling on
 * a query that will never finish.
 */
export const sql = postgres(url, {
	connection: { statement_timeout: 120_000 },
});
export const db = drizzle({ client: sql, schema });
export type Db = typeof db;
