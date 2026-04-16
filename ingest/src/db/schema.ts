import {
	boolean,
	index,
	integer,
	pgTable,
	primaryKey,
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
