export const languages = ["de", "en"] as const;
export type Lang = (typeof languages)[number];

const translations = {
	de: {
		"home.title": "DummRum",
		"home.subtitle": "Wissen, ob man dumm rumsteht",
		"home.methodology_title": "Wie wir messen",
		"home.methodology":
			"Alle 5 Minuten fragen wir die RMV-Echtzeitdaten ab und speichern Abfahrten, Ausfälle und Verspätungen. Die Ausfallquote ist der Anteil der ausgefallenen Abfahrten an der Gesamtzahl. Die Durchschnittsverspätung vergleicht die tatsächliche Abfahrtszeit mit der geplanten \u2014 bei Ausfällen wird der geplante Takt als Wartezeit angenommen. Als versp\u00e4tet gilt eine Abfahrt, wenn die Versp\u00e4tung \u226550% des geplanten Takts oder \u22657,5 Minuten betr\u00e4gt (50% der angenommenen durchschnittlichen Fahrtzeit von 15 Minuten innerhalb Frankfurts). Farben: gr\u00fcn unter 1% Ausfallquote, orange ab 1%, rot ab 2%.",
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
		"table.delayed": "Versp\u00e4tet",
		"table.delayed_tooltip":
			"Abfahrten mit \u226550% des geplanten Takts oder \u22657,5 Minuten Versp\u00e4tung (50% der angenommenen durchschnittlichen Fahrtzeit innerhalb Frankfurts von 15 Min.).",
		"table.rate": "Quote",
		"table.avg_delay": "\u00d8 Versp\u00e4tung",
		"table.freq_deviation": "Taktabweichung",
		"table.freq_deviation_tooltip":
			"Abweichung zwischen Ist- und Soll-Takt in Minuten. Positiv = seltener als geplant, negativ = h\u00e4ufiger. Berechnung: Ist-Takt \u2212 Soll-Takt.",
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
			"Every 5 minutes we poll the RMV realtime feed and store departures, cancellations, and delays. The cancellation rate is the share of cancelled departures out of the total. Average delay compares actual departure time to the scheduled time \u2014 for cancellations, we assume the wait equals the planned frequency. A departure counts as delayed if the delay is \u226550% of the planned frequency or \u22657.5 minutes (50% of the assumed average 15-minute trip time within Frankfurt). Colors: green below 1% cancellation rate, orange from 1%, red from 2%.",
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
		"table.delayed": "Delayed",
		"table.delayed_tooltip":
			"Departures delayed by \u226550% of planned frequency or \u22657.5 minutes (50% of assumed average 15 min trip time within Frankfurt).",
		"table.rate": "Rate",
		"table.avg_delay": "Avg delay",
		"table.freq_deviation": "Freq deviation",
		"table.freq_deviation_tooltip":
			"Difference between actual and planned frequency in minutes. Positive = less frequent than planned, negative = more frequent. Calculation: actual freq \u2212 planned freq.",
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
