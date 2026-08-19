import type { GetColumnData, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { journeyRuns } from "./schema.ts";

export const excluded = <C extends PgColumn>(column: C) => {
	return sql.raw(`excluded."${column.name}"`) as SQL<GetColumnData<C>>;
};

/** Feed a run's id is from, derived from the shape of its journey_ref.
 *
 * Lives here rather than in queries.ts because the poller writes the same
 * expression into stop_day_stats.lines that the read layer parses back out
 * — spelled twice they would drift, and the drift would be silent: a slug
 * built with the wrong source still looks like a slug.
 *
 * The pipe is escaped. Unescaped it read as an alternation — `^[12]` OR the
 * empty string — which matches every row, so the CASE could never reach
 * 'unknown'. Harmless to date because every journey_ref RMV emits does start
 * `1|` or `2|`, but it made the arm dead code rather than a check. Matches
 * `providerFromRef` in utils.ts, which always used the literal pipe. */
export const sourceSql = sql<string>`CASE
	WHEN ${journeyRuns.journeyRef} ~ '^[12]\\|' THEN 'rmv'
	ELSE 'unknown'
END`;

/** The `source:category:line` slug every line link on the site is keyed by.
 * `lineSlug`/`parseLineSlug` in utils.ts are the JS side of this format. */
export const lineSlugSql = sql<string>`(${sourceSql} || ':' || ${journeyRuns.categoryNorm} || ':' || ${journeyRuns.line})`;
