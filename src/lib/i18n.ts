export const languages = ["de", "en"] as const;
export type Lang = (typeof languages)[number];

const translations = {
	de: {
		"home.title": "DummRum",
		"home.subtitle": "Wissen, ob man dumm rumsteht",
		"home.methodology_title": "Wie wir messen",
		"home.methodology":
			"Alle 5 Minuten fragen wir die RMV-Echtzeitdaten ab und speichern Abfahrten, Ausfälle und Verspätungen. Die Ausfallquote ist der Anteil der ausgefallenen Abfahrten an der Gesamtzahl. Die Durchschnittsverspätung vergleicht die tatsächliche Abfahrtszeit mit der geplanten \u2014 bei Ausfällen wird der geplante Takt als Wartezeit angenommen.",
		"home.stations": "Haltestellen",
		"home.operators": "Betreiber",
		"home.cancelled": "ausgefallen",

		"hours.all": "Alle Zeiten",
		"hours.core": "Hauptverkehrszeit",
		"hours.core_range": "6\u20139 & 16\u201319 (HVZ)",

		"days.all": "Alle Tage",
		"days.weekdays": "Werktage",
		"days.weekends": "Wochenende",

		"nav.all_stations": "Alle Haltestellen",
		"nav.back": "Zur\u00fcck zur \u00dcbersicht",
		"nav.github": "Quellcode auf GitHub",

		"station.subtitle": "Ausfall- & Versp\u00e4tungstracker",
		"operator.lines": "Linien",
		"operator.daily_breakdown": "Tages\u00fcbersicht",
		"station.last_updated": "zuletzt aktualisiert",

		"stat.today": "Heute",
		"stat.no_data": "noch keine Daten",
		"stat.of_departures": "von {total} Abfahrten ({pct}%)",
		"stat.avg_per_day": "\u00d8 / Tag",
		"stat.cancelled": "ausgefallen",
		"stat.rate": "Quote",
		"stat.days_tracked": "Tage erfasst",
		"stat.since": "seit",
		"stat.departures": "Abfahrten",
		"stat.avg_delay": "\u00d8 Versp\u00e4tung",
		"stat.cancelled_eq_freq": "Ausfall = geplanter Takt",
		"stat.cancellation_rate": "Ausfallquote",

		"section.next_departures": "N\u00e4chste Abfahrten",
		"section.cancellation_rate": "Ausfallquote",
		"section.daily_breakdown": "Tages\u00fcbersicht",
		"section.all_departures": "Alle Abfahrten",

		"table.date": "Datum",
		"table.total": "Gesamt",
		"table.cancelled": "Ausf\u00e4lle",
		"table.rate": "Quote",
		"table.avg_delay": "\u00d8 Versp\u00e4tung",
		"table.planned_freq": "Soll-Takt",
		"table.actual_freq": "Ist-Takt",
		"table.time": "Zeit",
		"table.line": "Linie",
		"table.direction": "Richtung",
		"table.status": "Status",
		"table.delay": "Versp\u00e4tung",
		"table.last_checked": "Zuletzt gepr\u00fcft",
		"table.today": "heute",
		"table.no_data": "Noch keine Daten",
		"table.no_departures": "Keine Abfahrten",

		"status.cancelled": "ausgefallen",
		"status.ok": "ok",
		"status.on_time": "p\u00fcnktlich",
	},
	en: {
		"home.title": "DummRum",
		"home.subtitle": "Know if you\u2019re standing around for nothing",
		"home.methodology_title": "How we measure",
		"home.methodology":
			"Every 5 minutes we poll the RMV realtime feed and store departures, cancellations, and delays. The cancellation rate is the share of cancelled departures out of the total. Average delay compares actual departure time to the scheduled time \u2014 for cancellations, we assume the wait equals the planned frequency.",
		"home.stations": "Stations",
		"home.operators": "Operators",
		"home.cancelled": "cancelled",

		"hours.all": "All hours",
		"hours.core": "Core hours",
		"hours.core_range": "6\u20139 & 16\u201319 (HVZ)",

		"days.all": "All days",
		"days.weekdays": "Weekdays",
		"days.weekends": "Weekends",

		"nav.all_stations": "All stations",
		"nav.back": "Back to overview",
		"nav.github": "View source on GitHub",

		"station.subtitle": "Cancellation & delay tracker",
		"operator.lines": "Lines",
		"operator.daily_breakdown": "Daily breakdown",
		"station.last_updated": "last updated",

		"stat.today": "Today",
		"stat.no_data": "no data yet",
		"stat.of_departures": "of {total} departures ({pct}%)",
		"stat.avg_per_day": "Avg / day",
		"stat.cancelled": "cancelled",
		"stat.rate": "rate",
		"stat.days_tracked": "Days tracked",
		"stat.since": "since",
		"stat.departures": "Departures",
		"stat.avg_delay": "Avg delay",
		"stat.cancelled_eq_freq": "cancelled = planned freq",
		"stat.cancellation_rate": "cancellation rate",

		"section.next_departures": "Next departures",
		"section.cancellation_rate": "Cancellation rate",
		"section.daily_breakdown": "Daily breakdown",
		"section.all_departures": "All departures",

		"table.date": "Date",
		"table.total": "Total",
		"table.cancelled": "Cancelled",
		"table.rate": "Rate",
		"table.avg_delay": "Avg delay",
		"table.planned_freq": "Planned freq",
		"table.actual_freq": "Actual freq",
		"table.time": "Time",
		"table.line": "Line",
		"table.direction": "Direction",
		"table.status": "Status",
		"table.delay": "Delay",
		"table.last_checked": "Last checked",
		"table.today": "today",
		"table.no_data": "No data yet",
		"table.no_departures": "No departures",

		"status.cancelled": "cancelled",
		"status.ok": "ok",
		"status.on_time": "on time",
	},
} as const;

type TranslationKey = keyof (typeof translations)["en"];

export function t(
	lang: Lang,
	key: TranslationKey,
	params?: Record<string, string | number>,
): string {
	let text: string = translations[lang][key];
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			text = text.replace(`{${k}}`, String(v));
		}
	}
	return text;
}

export function langFromParams(
	params: Record<string, string | undefined>,
): Lang {
	const lang = params.lang;
	if (lang === "de" || lang === "en") return lang;
	return "de";
}
