import {
	boolean,
	index,
	integer,
	pgTable,
	primaryKey,
	real,
	serial,
	text,
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
		status: text().notNull(),
		cancelled: boolean().notNull().default(false),
		partCancelled: boolean("part_cancelled").notNull().default(false),
		cancelledStopCount: integer("cancelled_stop_count").notNull().default(0),
		totalStopCount: integer("total_stop_count").notNull(),
		wasTracked: boolean("was_tracked").notNull().default(false),
		pollState: text("poll_state"),
		polyline: text(),
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
		lat: real(),
		lon: real(),
	},
	(t) => [
		primaryKey({ columns: [t.journeyRef, t.dayOfOperation, t.routeIdx] }),
		index("idx_journey_stops_day").on(t.dayOfOperation),
		index("idx_journey_stops_stop_day").on(t.stopId, t.dayOfOperation),
	],
);

export const journeyPositions = pgTable(
	"journey_positions",
	{
		id: serial().primaryKey(),
		journeyRef: text("journey_ref").notNull(),
		dayOfOperation: text("day_of_operation").notNull(),
		lat: real().notNull(),
		lon: real().notNull(),
		reportedAt: text("reported_at").notNull(),
		routeIdx: integer("route_idx"),
		rtRouteIdx: integer("rt_route_idx"),
		capturedAt: text("captured_at").notNull(),
	},
	(t) => [
		index("idx_journey_pos_ref_day").on(t.journeyRef, t.dayOfOperation),
		index("idx_journey_pos_captured").on(t.capturedAt),
	],
);

// Pre-aggregated per-operator / per-line / per-stop rollups produced by the
// materialize* jobs. Stats pages read from these instead of scanning the
// full journey_runs / journey_stops tables on every request.

export const operatorDailyStats = pgTable(
	"operator_daily_stats",
	{
		operator: text().notNull(),
		date: text().notNull(),
		total: integer().notNull().default(0),
		cancelled: integer().notNull().default(0),
		ghost: integer().notNull().default(0),
		delayed: integer().notNull().default(0),
		avgDelay: real("avg_delay"),
	},
	(t) => [
		primaryKey({ columns: [t.operator, t.date] }),
		index("idx_operator_daily_stats_date").on(t.date),
	],
);

export const lineDailyStats = pgTable(
	"line_daily_stats",
	{
		line: text().notNull(),
		date: text().notNull(),
		total: integer().notNull().default(0),
		cancelled: integer().notNull().default(0),
		ghost: integer().notNull().default(0),
		delayed: integer().notNull().default(0),
		avgDelay: real("avg_delay"),
		category: text(),
		operators: text(),
		destinations: text(),
	},
	(t) => [
		primaryKey({ columns: [t.line, t.date] }),
		index("idx_line_daily_stats_date").on(t.date),
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
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [index("idx_known_stops_slug").on(t.slug)],
);
