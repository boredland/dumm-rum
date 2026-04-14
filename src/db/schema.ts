import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

export const haikus = sqliteTable("haikus", {
	date: text().primaryKey(),
	haiku: text().notNull(),
	haikuDe: text("haiku_de"),
});

export const operatorDailyStats = sqliteTable(
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

export const lineDailyStats = sqliteTable(
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

export const journeyRuns = sqliteTable(
	"journey_runs",
	{
		journeyRef: text("journey_ref").notNull(),
		dayOfOperation: text("day_of_operation").notNull(),
		line: text().notNull(),
		category: text(),
		operator: text(),
		lineId: text("line_id"),
		originStopId: text("origin_stop_id").notNull(),
		originName: text("origin_name").notNull(),
		originDepTime: text("origin_dep_time").notNull(),
		destStopId: text("dest_stop_id").notNull(),
		destName: text("dest_name").notNull(),
		destArrTime: text("dest_arr_time").notNull(),
		status: text().notNull(),
		cancelled: integer().notNull().default(0),
		partCancelled: integer("part_cancelled").notNull().default(0),
		cancelledStopCount: integer("cancelled_stop_count").notNull().default(0),
		totalStopCount: integer("total_stop_count").notNull(),
		wasTracked: integer("was_tracked").notNull().default(0),
		pollState: text("poll_state"),
		polyline: text(),
		snapshotAt: text("snapshot_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.journeyRef, t.dayOfOperation] }),
		index("idx_journey_runs_day").on(t.dayOfOperation),
		index("idx_journey_runs_line_day").on(t.line, t.dayOfOperation),
		index("idx_journey_runs_operator_day").on(t.operator, t.dayOfOperation),
		index("idx_journey_runs_poll_state").on(t.pollState, t.dayOfOperation),
	],
);

export const journeyPositions = sqliteTable(
	"journey_positions",
	{
		id: integer().primaryKey({ autoIncrement: true }),
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

export const journeyStops = sqliteTable(
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
		cancelled: integer().notNull().default(0),
		lat: real(),
		lon: real(),
	},
	(t) => [
		primaryKey({ columns: [t.journeyRef, t.dayOfOperation, t.routeIdx] }),
		index("idx_journey_stops_stop_day").on(t.stopId, t.dayOfOperation),
		index("idx_journey_stops_day").on(t.dayOfOperation),
	],
);

export const knownStops = sqliteTable(
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

export const telegramSubscriptions = sqliteTable(
	"telegram_subscriptions",
	{
		id: integer().primaryKey({ autoIncrement: true }),
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
