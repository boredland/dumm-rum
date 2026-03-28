export const languages = ["de", "en"] as const;
export type Lang = (typeof languages)[number];

const translations = {
	de: {
		"home.title": "DummRum",
		"home.subtitle": "Wissen, ob man dumm rumsteht",
		"home.methodology_title": "Wie wir messen",
		"home.methodology_collection":
			"Alle 5 Minuten fragen wir die RMV-Echtzeitdaten ab und speichern Abfahrten, Ausfälle und Verspätungen.",
		"home.methodology_cancellation":
			"Die Ausfallquote ist der Anteil der ausgefallenen Abfahrten an der Gesamtzahl.",
		"home.methodology_delay":
			"Die Durchschnittsverspätung vergleicht die tatsächliche Abfahrtszeit mit der geplanten \u2014 bei Ausfällen wird der geplante Takt als Wartezeit angenommen.",
		"home.methodology_delayed":
			"Als verspätet gilt eine Abfahrt, wenn die Verspätung \u226550% des geplanten Takts oder \u22657,5 Minuten beträgt (50% der angenommenen durchschnittlichen Fahrtzeit von 15 Minuten innerhalb Frankfurts).",
		"home.methodology_reliability":
			"Die Zuverlässigkeit (0\u2013100) kombiniert: Ausfallquote (Gewicht \u00d74) und Verspätungsquote (Gewicht \u00d72). 100 = perfekter Betrieb.",
		"home.methodology_colors":
			"Farben: grün ab 94 Punkten, orange 86\u201393, rot unter 86.",
		"home.overall_score": "Gesamtbewertung",
		"home.stations": "Haltestellen",
		"home.operators": "Betreiber",
		"home.lines": "Linien",
		"home.cancelled": "ausgefallen",
		"home.delayed": "versp\u00e4tet",

		"hours.all": "Alle Zeiten",
		"hours.core": "Hauptverkehrszeit",
		"hours.core_range": "6\u20139 & 16\u201319 (HVZ)",

		"days.all": "Alle Tage",
		"days.weekdays": "Werktage",
		"days.weekends": "Wochenende",

		"nav.all_stations": "Alle Haltestellen",
		"nav.back": "Zur\u00fcck zur \u00dcbersicht",
		"nav.back_to_line": "Zur\u00fcck zur Linie",
		"nav.back_to_operator": "Zur\u00fcck zum Betreiber",
		"nav.github": "Quellcode auf GitHub",

		"operator.lines": "Linien",
		"station.last_updated": "zuletzt aktualisiert",

		"stat.today": "Heute",
		"stat.of_departures": "von {total} Abfahrten",
		"stat.avg_per_day": "\u00d8 / Tag",
		"stat.cancelled": "ausgefallen",
		"stat.rate": "Quote",
		"stat.since": "Erfassung seit",
		"stat.departures": "Abfahrten",
		"stat.avg_delay": "\u00d8 Versp\u00e4tung",
		"stat.cancelled_eq_freq": "Ausfall = geplanter Takt",
		"stat.reliability": "Zuverlässigkeit",
		"stat.cancellation_rate": "Ausfallquote",

		"section.weekday_pattern": "Wochentag-Muster",
		"section.next_departures": "N\u00e4chste Abfahrten",
		"section.daily_breakdown": "Tages\u00fcbersicht",
		"section.all_departures": "Alle Abfahrten",

		"table.date": "Datum",
		"table.total": "Gesamt",
		"table.cancelled": "Ausf\u00e4lle",
		"table.delayed": "Versp\u00e4tet",
		"table.delayed_tooltip":
			"Abfahrten mit \u226550% des geplanten Takts oder \u22657,5 Minuten Versp\u00e4tung (50% der angenommenen durchschnittlichen Fahrtzeit innerhalb Frankfurts von 15 Min.).",
		"table.rate": "Quote",
		"table.avg_delay": "\u00d8 Versp\u00e4tung",
		"table.time": "Zeit",
		"table.line": "Linie",
		"table.direction": "Richtung",
		"table.status": "Status",
		"table.delay": "Versp\u00e4tung",
		"table.last_checked": "Zuletzt gepr\u00fcft",
		"table.today": "heute",
		"table.no_data": "Noch keine Daten",
		"table.no_departures": "Keine Abfahrten",

		"filter.all": "Alle",
		"filter.issues": "Ausfälle & Verspätungen",
		"filter.on_time": "Pünktlich",

		"status.cancelled": "ausgefallen",
		"status.ok": "ok",
		"status.on_time": "p\u00fcnktlich",
	},
	en: {
		"home.title": "DummRum",
		"home.subtitle": "Know if you\u2019re standing around for nothing",
		"home.methodology_title": "How we measure",
		"home.methodology_collection":
			"Every 5 minutes we poll the RMV realtime feed and store departures, cancellations, and delays.",
		"home.methodology_cancellation":
			"The cancellation rate is the share of cancelled departures out of the total.",
		"home.methodology_delay":
			"Average delay compares actual departure time to the scheduled time \u2014 for cancellations, we assume the wait equals the planned frequency.",
		"home.methodology_delayed":
			"A departure counts as delayed if the delay is \u226550% of the planned frequency or \u22657.5 minutes (50% of the assumed average 15-minute trip time within Frankfurt).",
		"home.methodology_reliability":
			"The reliability score (0\u2013100) combines: cancellation rate (weight \u00d74) and delayed departure rate (weight \u00d72). 100 = perfect service.",
		"home.methodology_colors":
			"Colors: green from 94 points, orange 86\u201393, red below 86.",
		"home.overall_score": "Overall score",
		"home.stations": "Stations",
		"home.operators": "Operators",
		"home.lines": "Lines",
		"home.cancelled": "cancelled",
		"home.delayed": "delayed",

		"hours.all": "All hours",
		"hours.core": "Core hours",
		"hours.core_range": "6\u20139 & 16\u201319 (HVZ)",

		"days.all": "All days",
		"days.weekdays": "Weekdays",
		"days.weekends": "Weekends",

		"nav.all_stations": "All stations",
		"nav.back": "Back to overview",
		"nav.back_to_line": "Back to line",
		"nav.back_to_operator": "Back to operator",
		"nav.github": "View source on GitHub",

		"operator.lines": "Lines",
		"station.last_updated": "last updated",

		"stat.today": "Today",
		"stat.of_departures": "of {total} departures",
		"stat.avg_per_day": "Avg / day",
		"stat.cancelled": "cancelled",
		"stat.rate": "rate",
		"stat.since": "tracking since",
		"stat.departures": "Departures",
		"stat.avg_delay": "Avg delay",
		"stat.cancelled_eq_freq": "cancelled = planned freq",
		"stat.reliability": "Reliability",
		"stat.cancellation_rate": "cancellation rate",

		"section.weekday_pattern": "Day-of-week pattern",
		"section.next_departures": "Next departures",
		"section.daily_breakdown": "Daily breakdown",
		"section.all_departures": "All departures",

		"table.date": "Date",
		"table.total": "Total",
		"table.cancelled": "Cancelled",
		"table.delayed": "Delayed",
		"table.delayed_tooltip":
			"Departures delayed by \u226550% of planned frequency or \u22657.5 minutes (50% of assumed average 15 min trip time within Frankfurt).",
		"table.rate": "Rate",
		"table.avg_delay": "Avg delay",
		"table.time": "Time",
		"table.line": "Line",
		"table.direction": "Direction",
		"table.status": "Status",
		"table.delay": "Delay",
		"table.last_checked": "Last checked",
		"table.today": "today",
		"table.no_data": "No data yet",
		"table.no_departures": "No departures",

		"filter.all": "All",
		"filter.issues": "Cancelled & delayed",
		"filter.on_time": "On time",

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
