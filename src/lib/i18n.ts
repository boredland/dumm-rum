export const languages = ["de", "en"] as const;
export type Lang = (typeof languages)[number];

const translations = {
	de: {
		"home.title": "DummRum",
		"home.subtitle": "Wissen, ob man dumm rumsteht",
		"home.methodology_title": "Wie wir messen",
		"home.methodology_collection":
			"Alle 3 Minuten fragen wir die RMV-Echtzeitdaten f\u00fcr zwei Haltestellen ab (ca. alle 15 Minuten pro Haltestelle) und speichern Abfahrten, Ausf\u00e4lle und Versp\u00e4tungen.",
		"home.methodology_cancellation":
			"Die Ausfallquote ist der Anteil der ausgefallenen Abfahrten an der Gesamtzahl.",
		"home.methodology_delay":
			"Die Durchschnittsverspätung vergleicht die tatsächliche Abfahrtszeit mit der geplanten \u2014 bei Ausfällen wird der geplante Takt als Wartezeit angenommen.",
		"home.methodology_delayed":
			"Als verspätet gilt eine Abfahrt, wenn die Verspätung \u226550% des geplanten Takts oder \u22657,5 Minuten beträgt (50% der angenommenen durchschnittlichen Fahrtzeit von 15 Minuten innerhalb Frankfurts).",
		"home.methodology_reliability":
			"Die P\u00fcnktlichkeitsquote (OTP) ist der Anteil der Abfahrten, die weder ausgefallen noch versp\u00e4tet sind \u2014 ein g\u00e4ngiger Standard im \u00d6PNV.",
		"home.methodology_dedup":
			"Für die Linien- und Betreiberstatistiken wird jede Fahrt nur einmal gezählt, auch wenn sie mehrere erfasste Haltestellen passiert \u2014 wir deduplizieren nach Fahrtnummer. Wird eine Fahrt an mehreren Haltestellen beobachtet, werden die früheste Abfahrtszeit und der schlechteste Status (ausgefallen > verspätet > pünktlich) verwendet.",
		"home.methodology_colors":
			"Farben: gr\u00fcn ab 90%, orange 80\u201389%, rot unter 80%.",
		"home.overall_score": "Pünktlich",
		"home.most_cancellations": "Meiste Ausfälle",
		"home.most_delays": "Meiste Verspätungen",
		"home.stations": "Haltestellen",
		"home.operators": "Betreiber",
		"home.lines": "Linien",
		"home.cancelled": "ausgefallen",
		"home.delayed": "versp\u00e4tet",
		"home.today": "Heute",
		"home.today_score": "Pünktlich heute",
		"home.worst_cancelled": "Meiste Ausfälle heute",
		"home.worst_delayed": "Meiste Verspätungen heute",
		"home.line": "Linie",
		"home.station": "Haltestelle",
		"home.operator": "Betreiber",

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
		"stat.reliability": "Pünktlich",
		"stat.cancellation_rate": "Ausfallquote",

		"section.weekday_pattern": "Zuverlässigkeit nach Wochentag",
		"section.next_departures": "N\u00e4chste Abfahrten",
		"section.daily_breakdown": "Tages\u00fcbersicht",
		"section.all_departures": "Alle Abfahrten",

		"table.date": "Datum",
		"table.total": "Gesamt",
		"table.cancelled": "Ausf\u00e4lle",
		"table.delayed": "Versp\u00e4tet",
		"table.rate": "Quote",
		"table.avg_delay": "\u00d8 Versp\u00e4tung",
		"table.time": "Zeit",
		"table.line": "Linie",
		"table.direction": "Richtung",
		"table.status": "Status",
		"table.delay": "Versp\u00e4tung",
		"table.station": "Haltestelle",
		"table.last_checked": "Zuletzt gepr\u00fcft",
		"table.today": "heute",
		"table.no_data": "Noch keine Daten",
		"table.no_departures": "Keine Abfahrten",

		"search.placeholder": "Linie, Haltestelle oder Betreiber suchen\u2026",

		"share.button": "Teilen",
		"share.copied": "Link kopiert!",
		"telegram.subscribe":
			"Über Verspätungen & Ausfälle per Telegram benachrichtigen",

		"filter.all": "Alle",
		"filter.issues": "Ausfälle & Verspätungen",
		"filter.on_time": "Pünktlich",

		"status.cancelled": "ausgefallen",
		"status.delayed": "verspätet",
		"status.ok": "ok",
		"status.on_time": "p\u00fcnktlich",
	},
	en: {
		"home.title": "DummRum",
		"home.subtitle": "Know if you\u2019re standing around for nothing",
		"home.methodology_title": "How we measure",
		"home.methodology_collection":
			"Every 3 minutes we poll the RMV realtime feed for two stations (approximately every 15 minutes per station) and store departures, cancellations, and delays.",
		"home.methodology_cancellation":
			"The cancellation rate is the share of cancelled departures out of the total.",
		"home.methodology_delay":
			"Average delay compares actual departure time to the scheduled time \u2014 for cancellations, we assume the wait equals the planned frequency.",
		"home.methodology_delayed":
			"A departure counts as delayed if the delay is \u226550% of the planned frequency or \u22657.5 minutes (50% of the assumed average 15-minute trip time within Frankfurt).",
		"home.methodology_reliability":
			"On-time performance (OTP) is the share of departures that were neither cancelled nor delayed \u2014 a standard metric in public transport.",
		"home.methodology_dedup":
			"For line and operator statistics, each journey is counted once even if it passes through multiple tracked stations \u2014 we deduplicate by journey number. When a journey is observed at several stations, the earliest departure time and worst status (cancelled > delayed > on-time) are used.",
		"home.methodology_colors":
			"Colors: green from 90%, orange 80\u201389%, red below 80%.",
		"home.overall_score": "On time",
		"home.most_cancellations": "Most cancellations",
		"home.most_delays": "Most delays",
		"home.stations": "Stations",
		"home.operators": "Operators",
		"home.lines": "Lines",
		"home.cancelled": "cancelled",
		"home.delayed": "delayed",
		"home.today": "Today",
		"home.today_score": "On time today",
		"home.worst_cancelled": "Most cancellations today",
		"home.worst_delayed": "Most delays today",
		"home.line": "Line",
		"home.station": "Station",
		"home.operator": "Operator",

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
		"stat.reliability": "On time",
		"stat.cancellation_rate": "cancellation rate",

		"section.weekday_pattern": "Reliability by weekday",
		"section.next_departures": "Next departures",
		"section.daily_breakdown": "Daily breakdown",
		"section.all_departures": "All departures",

		"table.date": "Date",
		"table.total": "Total",
		"table.cancelled": "Cancelled",
		"table.delayed": "Delayed",
		"table.rate": "Rate",
		"table.avg_delay": "Avg delay",
		"table.time": "Time",
		"table.line": "Line",
		"table.direction": "Direction",
		"table.status": "Status",
		"table.delay": "Delay",
		"table.station": "Station",
		"table.last_checked": "Last checked",
		"table.today": "today",
		"table.no_data": "No data yet",
		"table.no_departures": "No departures",

		"search.placeholder": "Search lines, stations, or operators\u2026",

		"share.button": "Share",
		"share.copied": "Link copied!",
		"telegram.subscribe":
			"Get notified about delays & cancellations via Telegram",

		"filter.all": "All",
		"filter.issues": "Cancelled & delayed",
		"filter.on_time": "On time",

		"status.cancelled": "cancelled",
		"status.delayed": "delayed",
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
