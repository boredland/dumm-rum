import { sql } from "drizzle-orm";
import {
	boolean,
	doublePrecision,
	index,
	integer,
	pgTable,
	primaryKey,
	serial,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";

export const journeyRuns = pgTable(
	"journey_runs",
	{
		journeyRef: text("journey_ref").notNull(),
		/** Surrogate key journey_stops references instead of carrying
		 * `journey_ref` on every row.
		 *
		 * `journey_ref` is a 158-175 byte HAFAS blob (avg 172). Stored 22.7M
		 * times over, and leading four of six journey_stops indexes, it was
		 * 17.1 GB of that table's 19 GB of indexes, plus ~172 of its ~326
		 * bytes per row. A 4-byte int in its place measured 43 MB/day against
		 * 206 MB/day for the same rows.
		 *
		 * int4, not bigint: at ~8.6k runs/day the sequence needs centuries to
		 * reach 2^31, and the extra 4 bytes would cost ~360 MB across
		 * journey_stops' indexes.
		 *
		 * Assigned by a sequence rather than derived from `journey_ref`. A
		 * hash would let the poller compute it without a round-trip, but a
		 * 32-bit hash collides at ~1% on 1M rows, and a 64-bit one gives up
		 * the int4 saving that is the entire point. */
		runId: integer("run_id")
			.notNull()
			.default(sql`nextval('journey_runs_run_id_seq')`),
		dayOfOperation: text("day_of_operation").notNull(),
		line: text().notNull(),
		category: text(),
		operator: text(),
		originStopId: text("origin_stop_id").notNull(),
		originName: text("origin_name").notNull(),
		originDepTime: text("origin_dep_time").notNull(),
		destStopId: text("dest_stop_id").notNull(),
		destName: text("dest_name").notNull(),
		destArrTime: text("dest_arr_time").notNull(),
		cancelled: boolean().notNull().default(false),
		wasTracked: boolean("was_tracked").notNull().default(false),
		pollState: text("poll_state"),
		snapshotAt: text("snapshot_at").notNull(),
		/** Display bucket for `category`, stored rather than derived per row.
		 * `normalize_category` runs several regex arms, so calling it inside a
		 * GROUP BY cost ~5x the raw column: 74 ms against 13 ms over 30 days of
		 * runs. Every summary query groups or filters on it.
		 *
		 * STORED, so changing `normalize_category` does NOT update rows that
		 * already exist. A migration that edits the function must rewrite the
		 * table too: `UPDATE journey_runs SET category = category`. */
		categoryNorm: text("category_norm").generatedAlwaysAs(
			sql`normalize_category(category)`,
		),
	},
	(t) => [
		primaryKey({ columns: [t.journeyRef, t.dayOfOperation] }),
		// The surrogate journey_stops joins on. Unique because it is a key in
		// everything but name: journey_stops rows are meaningless if two runs
		// can claim the same id, and the join would silently fan out.
		unique("journey_runs_run_id_idx").on(t.runId),
		index("idx_journey_runs_day").on(t.dayOfOperation),
		index("idx_journey_runs_poll_state").on(t.pollState, t.dayOfOperation),
		index("idx_journey_runs_line").on(t.line, t.dayOfOperation),
		index("idx_journey_runs_operator").on(t.operator, t.dayOfOperation),
		// Present in the database since 20260811105622 but missing from this
		// file, so every later `drizzle-kit generate` planned to drop it.
		// Declared here to stop that; the summary queries filter on
		// category_norm and the poller re-checks it per run.
		index("idx_journey_runs_cat_norm_day").on(t.categoryNorm, t.dayOfOperation),
		// idx_journey_runs_line_cover and idx_journey_runs_operator_cover —
		// covering indexes with INCLUDE payloads for the entity detail
		// pages — are created by
		// drizzle/20260813193000_entity_page_covering. Same reason as the
		// journey_stops one: this drizzle version's index builder has no
		// .include(), so declaring them here would drop the payload and make
		// every later `generate` plan to recreate them.
	],
);

export const journeyStops = pgTable(
	"journey_stops",
	{
		/** The run this stop visit belongs to, as journey_runs.run_id.
		 *
		 * Replaces the `journey_ref` this table used to carry on all 22.7M
		 * rows; see the column comment on journey_runs.run_id for the sizes
		 * that motivated it. Not a declared FOREIGN KEY: this schema has none
		 * anywhere, and the poller's tombstone paths delete stop visits while
		 * deliberately keeping the run row, which a cascade would fight. */
		runId: integer("run_id").notNull(),
		dayOfOperation: text("day_of_operation").notNull(),
		routeIdx: integer("route_idx").notNull(),
		stopId: text("stop_id").notNull(),
		stopName: text("stop_name").notNull(),
		depTime: text("dep_time"),
		arrTime: text("arr_time"),
		rtDepTime: text("rt_dep_time"),
		rtArrTime: text("rt_arr_time"),
		cancelled: boolean().notNull().default(false),
		/** Per-stop delay in minutes, precomputed at insert/update. NULL
		 * when the stop has no real-time pair.
		 *
		 * `delay_minutes` is a custom IMMUTABLE function rather than inline
		 * SQL, for the same reason as `normalize_category`: the midnight
		 * correction has to be spelled once. Written inline it would appear
		 * six times in this expression alone and drift the moment anyone
		 * edits one copy. See drizzle/20260817000000_delay_min_midnight. */
		delayMin: doublePrecision("delay_min").generatedAlwaysAs(
			sql`COALESCE(
				delay_minutes(dep_time, rt_dep_time),
				delay_minutes(arr_time, rt_arr_time)
			)`,
		),
	},
	(t) => [
		/** (run_id, route_idx) — `day_of_operation` is deliberately NOT in the
		 * key.
		 *
		 * The old key was (journey_ref, day_of_operation, route_idx), because
		 * (journey_ref, day_of_operation) is journey_runs' primary key. But
		 * run_id is unique on journey_runs by itself, so it already implies a
		 * day: adding day_of_operation back would widen every index entry by
		 * 11 bytes to re-state something run_id has already fixed.
		 *
		 * The column stays on the table — idx_journey_stops_stop_day and
		 * idx_journey_stops_day_name both lead with it, and getStopDayDepartures
		 * filters on it directly — it is just not part of the identity. */
		primaryKey({ columns: [t.runId, t.routeIdx] }),
		index("idx_journey_stops_stop_day").on(t.stopId, t.dayOfOperation),
		/** Also serves lookups on `day_of_operation` alone: a btree answers any
		 * query on a prefix of its columns, so the standalone index this
		 * replaced was 798 MB of duplicate storage on a 27 GB table. */
		index("idx_journey_stops_day_name").on(t.dayOfOperation, t.stopName),
		index("idx_journey_stops_delay_min")
			.on(t.runId)
			.where(sql`${t.delayMin} >= 7.5`),
		// idx_journey_stops_ref_day_name and idx_journey_stops_origin_rt —
		// covering indexes with INCLUDE payloads — are created by
		// drizzle/20260813190000_line_stops_covering and
		// drizzle/20260813200000_entity_day_origin_rt, and re-created on
		// run_id by drizzle/20260820120000_journey_stops_run_id.
		// They are not declared here because this drizzle version's index
		// builder has no .include(), and declaring them without the payload
		// would make every later `generate` plan to drop and recreate them.
		// See those migrations for what they do and why.
	],
);

/**
 * Per-(stop, day) aggregate of journey_stops, joined against journey_runs
 * at write time so reads never have to.
 *
 * The stat pages only ever count stop visits — total / cancelled / ghost /
 * delayed per day. Computing that from the raw rows means joining a stop's
 * entire history against journey_runs on every SWR miss, which is what made
 * an uncached stop page cost seconds in prod: ~390k stop-visit rows per stop
 * against 1.25M runs, with the hash join spilling to disk. Rolled up, one
 * stop-day is a single row — measured 149x fewer rows locally (449k -> 3k),
 * and the ratio grows with history because a stop sees roughly the same
 * number of departures every day.
 *
 * Raw journey_stops rows are NOT deleted: `getStopDayDepartures` still reads
 * them for the per-departure drill-down, at any date. This table is a read
 * accelerator, not a retention policy.
 *
 * `ghost` counts runs that were never tracked and not cancelled, so it is a
 * property of the run rather than the stop visit — which is why the rollup
 * has to be computed across the join rather than from journey_stops alone.
 */
export const stopDayStats = pgTable(
	"stop_day_stats",
	{
		stopId: text("stop_id").notNull(),
		dayOfOperation: text("day_of_operation").notNull(),
		stopName: text("stop_name").notNull(),
		total: integer().notNull().default(0),
		cancelled: integer().notNull().default(0),
		ghost: integer().notNull().default(0),
		delayed: integer().notNull().default(0),
		/** Newest journey_runs.snapshot_at across the stop-day, so
		 * getStopStats can report "last updated" without touching runs. */
		lastChange: text("last_change"),
		/** Comma-separated normalized categories seen at this stop-day.
		 * Aggregated across days in JS, same shape dedupeCsv already takes. */
		categories: text(),
		/** Comma-separated `source:category:line` slugs seen at this stop-day,
		 * same shape and reason as `categories`. Without it getStopSummaries
		 * had to sort ~493k raw stop visits down to ~2.6k distinct tuples on
		 * every miss: 276 ms against 3.9 ms read from here. */
		lines: text(),
	},
	(t) => [
		primaryKey({ columns: [t.stopId, t.dayOfOperation] }),
		index("idx_stop_day_stats_day").on(t.dayOfOperation),
	],
);

/**
 * Stop-id -> slug rollup, written by the poller for every stop it sees.
 * Exists so `findStopBySlug` is one indexed lookup: `nameToSlug` does
 * umlaut transliteration plus NFD normalization in JS and can't be
 * reproduced in SQL, so the slug has to be materialized on write.
 */
export const knownStops = pgTable(
	"known_stops",
	{
		stopId: text("stop_id").primaryKey(),
		stopName: text("stop_name").notNull(),
		slug: text(),
	},
	(t) => [index("idx_known_stops_slug").on(t.slug)],
);

/**
 * Key-value cache used as a cheap KV store — currently backs the memo
 * layer behind the picker endpoints, and intended as a general-purpose
 * spot for responses we want to hold beyond a process restart. The
 * table name intentionally starts with `unlogged_` to signal the
 * migration should be hand-edited to `CREATE UNLOGGED TABLE` (drizzle
 * doesn't emit that modifier). Unlogged = no WAL churn, lower
 * durability guarantees, which is exactly right for recomputable
 * data. Hash index on `key` since we only do exact-key lookups.
 */
export const unloggedCache = pgTable(
	"unlogged_cache",
	{
		key: text("key").primaryKey(),
		value: text("value").notNull(),
		/** Optional expiry — null = never expires. Callers that want a TTL
		 * set this to `now() + ttl`; cache reads skip rows where
		 * `expiresAt < now()`. A separate sweeper can GC them. */
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("idx_unlogged_cache_key").using("hash", t.key)],
);

export const telegramSubscriptions = pgTable(
	"telegram_subscriptions",
	{
		id: serial().primaryKey(),
		chatId: text("chat_id").notNull(),
		lang: text().notNull().default("de"),
		line: text().notNull(),
		direction: text().notNull(),
		stopId: text("stop_id").notNull().default(""),
		timeRanges: text("time_ranges"),
		weekdays: text(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		unique().on(t.chatId, t.line, t.direction, t.stopId),
		index("idx_telegram_line_dir").on(t.line, t.direction),
	],
);
