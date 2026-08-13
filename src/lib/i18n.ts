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
		"home.methodology_delayed":
			"Als verspätet gilt eine nicht ausgefallene Abfahrt, wenn die Echtzeit \u22657,5 Minuten nach dem Fahrplan liegt \u2014 gemessen an der Abfahrtszeit, ersatzweise an der Ankunftszeit (z. B. an Endhaltestellen).",
		"home.methodology_reliability":
			"Die P\u00fcnktlichkeitsquote (OTP) ist der Anteil der Abfahrten, die weder ausgefallen noch versp\u00e4tet sind \u2014 ein g\u00e4ngiger Standard im \u00d6PNV.",
		"home.methodology_dedup":
			"Für die Linien- und Betreiberstatistiken wird jede Fahrt nur einmal gezählt, auch wenn sie mehrere erfasste Haltestellen passiert \u2014 wir deduplizieren nach Fahrtnummer. Wird eine Fahrt an mehreren Haltestellen beobachtet, werden die früheste Abfahrtszeit und der schlechteste Status (ausgefallen > verspätet > pünktlich) verwendet.",
		"home.methodology_colors":
			"Farben: gr\u00fcn ab 90%, orange 80\u201389%, rot unter 80%.",
		"home.finding":
			"Von {total} erfassten Fahrten sind {rate} p\u00fcnktlich gefahren.",
		"home.finding_ghosts":
			"Rechnet man Geisterfahrten als Ausfall, sind es {rate}.",
		"home.worst_heading": "Auff\u00e4lligste Werte",
		"home.window_today": "Heute",
		"home.window_range": "Letzte 30 Tage",
		"home.overall_score": "Pünktlich",
		"home.most_cancellations": "Meiste Ausfälle",
		"home.most_ghosts": "Meiste Geisterfahrten",
		"home.most_delays": "Meiste Verspätungen",
		"home.stations": "Haltestellen",
		"home.operators": "Betreiber",
		"home.lines": "Linien",
		"home.filtered_by": "Gefiltert nach: {filters}",
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
		"nav.report_bug": "Fehler melden",

		"operator.lines": "Linien",
		"station.last_updated": "zuletzt aktualisiert",
		"station.seven_day":
			"7 Tage: {total} Fahrten · {cancelled} ausgefallen · {ghost} Geisterfahrten · {delayed} verspätet · {score} % pünktlich",

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
		"table.th.total": "Fahrten",
		"table.th.cancelled": "Ausfälle",
		"table.th.ghost": "Geister",
		"table.th.delayed": "Verspätet",
		"table.otp": "Pünktlich",
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
		"subscribe.cta.button": "Benachrichtigen",
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
		"map.link": "Live-Karte",
		"map.vehicles": "Fahrzeuge",
		"map.last_update": "Letztes Update",
		"map.no_vehicles": "Keine aktiven Fahrzeuge",
		"map.layer_gps": "GPS (Echtzeit)",
		"map.layer_realtime": "Echtzeit (berechnet)",
		"map.layer_schedule": "Fahrplan",
		"map.gps_fix_now": "GPS gerade eben",
		"map.gps_fix_ago": "GPS vor {t}",
		"map.gps_fix_calc": "Position berechnet",

		"status.cancelled": "ausgefallen",
		"status.ghost": "Geisterfahrt",
		"status.delayed": "verspätet",
		"status.ok": "pünktlich",
		"status.on_time": "p\u00fcnktlich",
		"status.delayed_by": "+{min} min",

		"board.reliability_index": "P\u00fcnktlichkeitsindex",
		"board.status_monitor": "Statusanzeige",
		"board.tracked": "erfasst",
		"board.line_label": "Linie",
		"board.station_label": "Haltestelle",
		"board.operator_label": "Betreiber",

		"notfound.heading": "Geisterseite",
		"notfound.subheading": "Im Fahrplan — trotzdem nie angekommen.",
		"notfound.body":
			"Diese Seite ist offenbar eine Geisterfahrt. Im Plan stand sie \u2014 am Bahnsteig ist sie aber nie eingefahren.",
		"notfound.board.header": "N\u00e4chste Abfahrt von hier",
		"notfound.board.time": "—:—",
		"notfound.board.line": "404",
		"notfound.board.destination": "irgendwohin, wo du hinwolltest",
		"notfound.board.status": "f\u00e4llt aus",
		"notfound.cta": "Zur\u00fcck zur \u00dcbersicht",
		"notfound.tip":
			"Tipp: Wenn dich ein Link innerhalb von DummRum hierher gef\u00fchrt hat, sag uns Bescheid \u2014 dann flicken wir die Wegweisung.",
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
		"home.methodology_delayed":
			"A non-cancelled departure counts as delayed when its realtime is \u22657.5 minutes behind schedule \u2014 measured on departure time, falling back to arrival time (e.g. at terminus stops).",
		"home.methodology_reliability":
			"On-time performance (OTP) is the share of departures that were neither cancelled nor delayed \u2014 a standard metric in public transport.",
		"home.methodology_dedup":
			"For line and operator statistics, each journey is counted once even if it passes through multiple tracked stations \u2014 we deduplicate by journey number. When a journey is observed at several stations, the earliest departure time and worst status (cancelled > delayed > on-time) are used.",
		"home.methodology_colors":
			"Colors: green from 90%, orange 80\u201389%, red below 80%.",
		"home.finding": "Of {total} tracked trips, {rate} ran on time.",
		"home.finding_ghosts":
			"Counting ghost runs as cancellations, it is {rate}.",
		"home.worst_heading": "Notable figures",
		"home.window_today": "Today",
		"home.window_range": "Last 30 days",
		"home.overall_score": "On time",
		"home.most_cancellations": "Most cancellations",
		"home.most_ghosts": "Most ghost runs",
		"home.most_delays": "Most delays",
		"home.stations": "Stations",
		"home.operators": "Operators",
		"home.lines": "Lines",
		"home.filtered_by": "Filtered by: {filters}",
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
		"nav.report_bug": "Report a bug",

		"operator.lines": "Lines",
		"station.last_updated": "last updated",
		"station.seven_day":
			"7 days: {total} trips · {cancelled} cancelled · {ghost} ghost · {delayed} delayed · {score} % on time",

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
		"table.th.total": "Trips",
		"table.th.cancelled": "Cancelled",
		"table.th.ghost": "Ghost",
		"table.th.delayed": "Delayed",
		"table.otp": "On time",
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
		"subscribe.cta.button": "Notify me",
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
		"map.link": "Live Map",
		"map.vehicles": "Vehicles",
		"map.last_update": "Last update",
		"map.no_vehicles": "No active vehicles",
		"map.layer_gps": "GPS (Live)",
		"map.layer_realtime": "Realtime (Calc)",
		"map.layer_schedule": "Schedule",
		"map.gps_fix_now": "GPS just now",
		"map.gps_fix_ago": "GPS {t} ago",
		"map.gps_fix_calc": "Position calculated",

		"status.cancelled": "cancelled",
		"status.ghost": "ghost run",
		"status.delayed": "delayed",
		"status.ok": "on time",
		"status.on_time": "on time",
		"status.delayed_by": "+{min} min",

		"board.reliability_index": "Reliability index",
		"board.status_monitor": "Status monitor",
		"board.tracked": "tracked",
		"board.line_label": "Line",
		"board.station_label": "Station",
		"board.operator_label": "Operator",

		"notfound.heading": "Ghost page",
		"notfound.subheading": "Scheduled — never showed up.",
		"notfound.body":
			"Looks like this page is a ghost run. The timetable says it was supposed to be here, but the system never saw it pull up at the platform.",
		"notfound.board.header": "Next departure from here",
		"notfound.board.time": "—:—",
		"notfound.board.line": "404",
		"notfound.board.destination": "wherever you were headed",
		"notfound.board.status": "not in service",
		"notfound.cta": "Back to the overview",
		"notfound.tip":
			"Tip: if you got here by clicking a link in DummRum itself, please report it — we'd like to fix the signage.",
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

/** Split a translation into literal chunks and named placeholders so a
 * caller can render a placeholder as an element — a toned figure, a link —
 * instead of flattening it into the string. Keeps each sentence a single
 * translatable unit rather than three fragments the translator has to
 * reassemble in the right order.
 *
 * `tParts(l, "home.finding")` → `["Of ", {param:"total"}, " tracked trips, ", …]`
 */
export function tParts(
	lang: Lang,
	key: TranslationKey,
): Array<string | { param: string }> {
	const parts: Array<string | { param: string }> = [];
	const template: string = translations[lang][key];
	let last = 0;
	for (const m of template.matchAll(/\{(\w+)\}/g)) {
		if (m.index > last) parts.push(template.slice(last, m.index));
		parts.push({ param: m[1] });
		last = m.index + m[0].length;
	}
	if (last < template.length) parts.push(template.slice(last));
	return parts;
}

export function langFromParams(
	params: Record<string, string | undefined>,
): Lang {
	const lang = params.lang;
	if (lang === "de" || lang === "en") return lang;
	return "de";
}
