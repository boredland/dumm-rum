export const languages = ["de", "en"] as const;
export type Lang = (typeof languages)[number];

const translations = {
	de: {
		"home.title": "DummRum",
		"home.subtitle": "Wissen, ob man dumm rumsteht",
		"home.methodology_title": "Wie wir messen",
		"home.methodology_collection":
			"Alle 5 Minuten rufen wir den RMV-Echtzeit-Feed f\u00fcr alle erfassten Haltestellen ab und speichern die Abfahrtszeiten. Anschlie\u00dfend wird jede Fahrt einzeln alle 60 Sekunden \u00fcber die HAFAS-API f\u00fcr Fahrtdetails abgefragt, um Echtzeitdaten f\u00fcr jede Haltestelle und Ausf\u00e4lle zu erfassen.",
		"home.methodology_cancellation":
			"Die Ausfallquote ist der Anteil der ausgefallenen Abfahrten an der Gesamtzahl.",
		"home.methodology_ghost":
			"Geisterfahrten (👻) sind geplante Abfahrten, die nie Echtzeitdaten erhalten haben. Laut RMV ist das Fehlen von Echtzeitdaten \u201eein sehr starkes Indiz, dass dieser Bus mit hoher Wahrscheinlichkeit ausfallen wird\u201c \u2014 das System empfängt keine Live-Position, weil schlicht kein Bus auf dieser Fahrt unterwegs ist. Diese werden getrennt von bestätigten Ausfällen erfasst.",
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
		"home.most_ghosts": "Meiste 👻",
		"home.most_delays": "Meiste Verspätungen",
		"home.stations": "Haltestellen",
		"home.operators": "Betreiber",
		"home.lines": "Linien",
		"home.cancelled": "ausgefallen",
		"home.delayed": "versp\u00e4tet",
		"home.line": "Linie",
		"home.station": "Haltestelle",
		"home.operator": "Betreiber",

		"hours.all": "Alle Zeiten",
		"hours.core": "Hauptverkehrszeit",

		"days.all": "Alle Tage",
		"days.today": "Heute",
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
		"stat.ghost": "Geisterfahrten",
		"stat.rate": "Quote",
		"stat.since": "Erfassung seit",
		"haiku.heading": "Haiku des Tages",
		"stat.departures": "Abfahrten",
		"stat.reliability": "Pünktlich",
		"stat.cancellation_rate": "Ausfallquote",

		"section.weekday_pattern": "Zuverlässigkeit nach Wochentag",
		"section.next_departures": "N\u00e4chste Abfahrten",
		"section.daily_breakdown": "Tages\u00fcbersicht",
		"section.all_departures": "Alle Abfahrten",

		"table.date": "Datum",
		"table.total": "Gesamt",
		"table.cancelled": "Ausfälle",
		"table.delayed": "Verspätungen",
		"table.th.total": "Σ",
		"table.th.cancelled": "❌",
		"table.th.ghost": "👻",
		"table.th.delayed": "⏳",
		"table.otp": "💯",
		"table.time": "Zeit",
		"table.line": "Linie",
		"table.direction": "Richtung",
		"table.status": "Status",
		"table.station": "Haltestelle",
		"table.today": "heute",
		"table.no_data": "Noch keine Daten",
		"table.no_departures": "Keine Abfahrten",

		"search.placeholder": "Linie, Haltestelle oder Betreiber suchen\u2026",

		"share.button": "Teilen",
		"share.copied": "Link kopiert!",
		"telegram.subscribe":
			"Über Verspätungen & Ausfälle per Telegram benachrichtigen",
		"subscribe.cta.button": "🔔 Alarm einrichten",
		"subscribe.modal.title": "Alarm per Telegram",
		"subscribe.modal.subtitle":
			"Wir öffnen den Telegram-Bot mit deinen Einstellungen. Tippe dort auf /subscribe, um den Alarm zu aktivieren.",
		"subscribe.line": "Linie",
		"subscribe.direction": "Richtung",
		"subscribe.direction.any": "Beliebige Richtung",
		"subscribe.stop": "Haltestelle",
		"subscribe.stop.any": "Alle Haltestellen",
		"subscribe.hours": "Zeitfenster",
		"subscribe.hours.add_range": "Weiteres Zeitfenster",
		"subscribe.hours.remove_range": "Entfernen",
		"subscribe.weekdays": "Wochentage",
		"subscribe.submit": "In Telegram öffnen",
		"subscribe.cancel": "Abbrechen",

		"filter.all": "Alle",
		"filter.all_directions": "Alle Richtungen",
		"filter.issues": "Ausfälle & Verspätungen",
		"filter.on_time": "Pünktlich",

		"home.ghost": "Geisterfahrten",

		"map.title": "Livekarte",
		"map.vehicles": "Fahrzeuge",
		"map.last_update": "Letztes Update",
		"map.no_vehicles": "Keine aktiven Fahrzeuge",

		"status.cancelled": "❌",
		"status.ghost": "👻",
		"status.delayed": "⏳",
		"status.ok": "✅",
		"status.on_time": "p\u00fcnktlich",
	},
	en: {
		"home.title": "DummRum",
		"home.subtitle": "Know if you\u2019re standing around for nothing",
		"home.methodology_title": "How we measure",
		"home.methodology_collection":
			"Every 5 minutes we poll the RMV realtime feed for all tracked stations and store departures. Each journey is then polled individually every 60 seconds via the HAFAS journey detail API to capture per-stop realtime data and cancellations.",
		"home.methodology_cancellation":
			"The cancellation rate is the share of cancelled departures out of the total.",
		"home.methodology_ghost":
			"Ghost departures (👻) are scheduled trips that never received realtime data. According to RMV, the absence of realtime data is \u201ca very strong indicator that the bus will very likely not run\u201d \u2014 the system cannot receive a live position because there simply is no bus on that route. These are tracked separately from confirmed cancellations.",
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
		"home.most_ghosts": "Most 👻",
		"home.most_delays": "Most delays",
		"home.stations": "Stations",
		"home.operators": "Operators",
		"home.lines": "Lines",
		"home.cancelled": "cancelled",
		"home.delayed": "delayed",
		"home.line": "Line",
		"home.station": "Station",
		"home.operator": "Operator",

		"hours.all": "All hours",
		"hours.core": "Core hours",

		"days.all": "All days",
		"days.today": "Today",
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
		"stat.ghost": "ghost departures",
		"stat.rate": "rate",
		"stat.since": "tracking since",
		"haiku.heading": "Haiku of the day",
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
		"table.th.total": "Σ",
		"table.th.cancelled": "❌",
		"table.th.ghost": "👻",
		"table.th.delayed": "⏳",
		"table.otp": "💯",
		"table.time": "Time",
		"table.line": "Line",
		"table.direction": "Direction",
		"table.status": "Status",
		"table.station": "Station",
		"table.today": "today",
		"table.no_data": "No data yet",
		"table.no_departures": "No departures",

		"search.placeholder": "Search lines, stations, or operators\u2026",

		"share.button": "Share",
		"share.copied": "Link copied!",
		"telegram.subscribe":
			"Get notified about delays & cancellations via Telegram",
		"subscribe.cta.button": "🔔 Set up alert",
		"subscribe.modal.title": "Telegram alert",
		"subscribe.modal.subtitle":
			"We'll open the Telegram bot with your settings. Tap /subscribe there to activate the alert.",
		"subscribe.line": "Line",
		"subscribe.direction": "Direction",
		"subscribe.direction.any": "Any direction",
		"subscribe.stop": "Stop",
		"subscribe.stop.any": "All stops",
		"subscribe.hours": "Time window",
		"subscribe.hours.add_range": "Add range",
		"subscribe.hours.remove_range": "Remove",
		"subscribe.weekdays": "Weekdays",
		"subscribe.submit": "Open in Telegram",
		"subscribe.cancel": "Cancel",

		"filter.all": "All",
		"filter.all_directions": "All directions",
		"filter.issues": "Cancelled & delayed",
		"filter.on_time": "On time",

		"home.ghost": "ghost departures",

		"map.title": "Live Map",
		"map.vehicles": "Vehicles",
		"map.last_update": "Last update",
		"map.no_vehicles": "No active vehicles",

		"status.cancelled": "❌",
		"status.ghost": "👻",
		"status.delayed": "⏳",
		"status.ok": "✅",
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
