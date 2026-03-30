import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";

export const departures = sqliteTable(
	"departures",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		stationId: text("station_id").notNull(),
		date: text().notNull(),
		time: text().notNull(),
		rtDate: text("rt_date"),
		rtTime: text("rt_time"),
		line: text().notNull(),
		direction: text().notNull(),
		journeyStatus: text("journey_status").notNull().default("P"),
		cancelled: integer().notNull().default(0),
		operator: text(),
		category: text(),
		journeyNum: text("journey_num").notNull(),
		reachable: integer(),
		stop: text(),
		stopExtId: text("stop_ext_id"),
		messages: text(),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		unique().on(t.stationId, t.date, t.time, t.line, t.direction, t.journeyNum),
		index("idx_departures_station_date").on(t.stationId, t.date),
		index("idx_departures_next").on(t.stationId, t.date, t.cancelled, t.time),
		index("idx_departures_fetched").on(t.fetchedAt),
		index("idx_departures_operator_line").on(t.operator, t.line, t.date),
		index("idx_departures_date").on(t.date),
	],
);

export const haikus = sqliteTable("haikus", {
	date: text().primaryKey(),
	haiku: text().notNull(),
});

export const stationDailyStats = sqliteTable(
	"station_daily_stats",
	{
		stationId: text("station_id").notNull(),
		date: text().notNull(),
		total: integer().notNull().default(0),
		cancelled: integer().notNull().default(0),
		delayed: integer().notNull().default(0),
		avgDelay: real("avg_delay"),
	},
	(t) => [primaryKey({ columns: [t.stationId, t.date] })],
);

export const operatorDailyStats = sqliteTable(
	"operator_daily_stats",
	{
		operator: text().notNull(),
		date: text().notNull(),
		total: integer().notNull().default(0),
		cancelled: integer().notNull().default(0),
		delayed: integer().notNull().default(0),
		avgDelay: real("avg_delay"),
	},
	(t) => [primaryKey({ columns: [t.operator, t.date] })],
);

export const telegramSubscriptions = sqliteTable(
	"telegram_subscriptions",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		chatId: text("chat_id").notNull(),
		line: text().notNull(),
		direction: text().notNull(),
		timeRanges: text("time_ranges"),
		weekdays: text(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		unique().on(t.chatId, t.line, t.direction),
		index("idx_telegram_line_dir").on(t.line, t.direction),
	],
);
