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
	},
	(t) => [
		primaryKey({ columns: [t.journeyRef, t.dayOfOperation] }),
		index("idx_journey_runs_day").on(t.dayOfOperation),
		index("idx_journey_runs_poll_state").on(t.pollState, t.dayOfOperation),
		index("idx_journey_runs_line").on(t.line, t.dayOfOperation),
		index("idx_journey_runs_operator").on(t.operator, t.dayOfOperation),
	],
);

export const journeyStops = pgTable(
	"journey_stops",
	{
		journeyRef: text("journey_ref").notNull(),
		dayOfOperation: text("day_of_operation").notNull(),
		routeIdx: integer("route_idx").notNull(),
		stopId: text("stop_id").notNull(),
		stopName: text("stop_name").notNull(),
		depTime: text("dep_time"),
		arrTime: text("arr_time"),
		rtDepTime: text("rt_dep_time"),
		rtArrTime: text("rt_arr_time"),
		cancelled: boolean().notNull().default(false),
		/** Stop coordinates — WGS84 degrees. Nullable because the RMV
		 * ingest doesn't populate them (HAFAS delivers positions via a
		 * separate live-map feed). KVV's EFA includes coords in every
		 * TripStopTimes response, so every kvv-source row carries them. */
		lat: doublePrecision("lat"),
		lon: doublePrecision("lon"),
	},
	(t) => [
		primaryKey({ columns: [t.journeyRef, t.dayOfOperation, t.routeIdx] }),
		index("idx_journey_stops_day").on(t.dayOfOperation),
		index("idx_journey_stops_stop_day").on(t.stopId, t.dayOfOperation),
	],
);

export const knownStops = pgTable(
	"known_stops",
	{
		stopId: text("stop_id").primaryKey(),
		stopName: text("stop_name").notNull(),
		slug: text(),
		lines: text(),
		categories: text(),
		journeyCount: integer("journey_count").notNull().default(0),
		cancelled: integer().notNull().default(0),
		ghost: integer().notNull().default(0),
		delayed: integer().notNull().default(0),
	},
	(t) => [index("idx_known_stops_slug").on(t.slug)],
);

/**
 * Key-value cache used as a cheap KV store — currently backs the
 * bahn.expert polyline cache but intended as a general-purpose spot for
 * third-party responses we want to hold beyond a process restart. The
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
