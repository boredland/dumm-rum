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
		cancelled: integer().notNull().default(0),
		operator: text(),
		category: text(),
		journeyNum: text("journey_num").notNull(),
		journeyRef: text("journey_ref"),
		journeyStatus: text("journey_status"),
		stop: text(),
		ghost: integer().notNull().default(0),
		notified: integer().notNull().default(0),
		fetchedAt: text("fetched_at").notNull(),
	},
	(t) => [
		unique().on(t.stationId, t.date, t.time, t.line, t.direction, t.journeyNum),
		index("idx_departures_station_date").on(t.stationId, t.date),
		index("idx_departures_station_fetched").on(t.stationId, t.fetchedAt),
		index("idx_departures_operator_date").on(t.operator, t.date),
		index("idx_departures_date").on(t.date),
		index("idx_departures_line_date").on(t.line, t.date),
		index("idx_departures_date_notified").on(t.date, t.notified),
	],
);

export const haikus = sqliteTable("haikus", {
	date: text().primaryKey(),
	haiku: text().notNull(),
	haikuDe: text("haiku_de"),
});

export const stationDailyStats = sqliteTable(
	"station_daily_stats",
	{
		stationId: text("station_id").notNull(),
		date: text().notNull(),
		total: integer().notNull().default(0),
		cancelled: integer().notNull().default(0),
		ghost: integer().notNull().default(0),
		delayed: integer().notNull().default(0),
		avgDelay: real("avg_delay"),
	},
	(t) => [
		primaryKey({ columns: [t.stationId, t.date] }),
		index("idx_station_daily_stats_date").on(t.date),
	],
);

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

export const telegramSubscriptions = sqliteTable(
	"telegram_subscriptions",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		chatId: text("chat_id").notNull(),
		lang: text().notNull().default("de"),
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
