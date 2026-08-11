export interface Station {
	id: string;
	name: string;
	slug: string;
	excludeCategories?: string[];
}

export const STATIONS: Station[] = [
	{
		id: "3000129",
		name: "Frankfurt (Main) Leonardo-Da-Vinci-Allee",
		slug: "leonardo-da-vinci-allee",
	},
	{
		id: "3000502",
		name: "Frankfurt (Main) Höhenstraße",
		slug: "hoehenstrasse",
	},
	{
		id: "3000510",
		name: "Frankfurt (Main) Konstablerwache",
		slug: "konstablerwache",
	},
	{
		id: "3000912",
		name: "Frankfurt (Main) Südbahnhof",
		slug: "suedbahnhof",
	},
	{
		id: "3000933",
		name: "Frankfurt (Main) Stresemannallee Bahnhof",
		slug: "stresemannallee-bahnhof",
	},
	{
		id: "3001008",
		name: "Frankfurt (Main) Höchst Bahnhof",
		slug: "hoechst-bahnhof",
	},
	{
		id: "3001507",
		name: "Frankfurt (Main) Bornheim Mitte",
		slug: "bornheim-mitte",
	},
	{
		id: "3001446",
		name: "Frankfurt (Main) Preungesheim",
		slug: "preungesheim",
	},
	{
		id: "3001586",
		name: "Frankfurt (Main) Draisbornstraße",
		slug: "draisbornstrasse",
	},
	{
		id: "3001217",
		name: "Frankfurt (Main) Rödelheim Bahnhof",
		slug: "roedelheim-bahnhof",
	},
	{
		id: "3002599",
		name: "Frankfurt (Main) Mainkur Bahnhof",
		slug: "mainkur-bahnhof",
	},
	{
		id: "3007011",
		name: "Frankfurt (Main) Hauptbahnhof",
		slug: "hauptbahnhof",
	},
	{
		id: "3006903",
		name: "Wiesbaden-Mainz-Kastel Bahnhof",
		slug: "mainz-kastel-bahnhof",
		excludeCategories: ["Bus"],
	},
];

const GERMAN_MAP: Record<string, string> = {
	ä: "ae",
	ö: "oe",
	ü: "ue",
	ß: "ss",
	Ä: "Ae",
	Ö: "Oe",
	Ü: "Ue",
};

/** Stable URL slug for a station name. Used by the known_stops rollup so
 * the UI's station pages have a routable path for every stop seen in the
 * wild (not just the configured STATIONS list). */
export function nameToSlug(name: string): string {
	return name
		.replace(/^Frankfurt \(Main\)\s*/i, "")
		.replace(/[äöüßÄÖÜ]/g, (ch) => GERMAN_MAP[ch] ?? ch)
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

const SLUG_BY_STOP_ID = new Map(STATIONS.map((s) => [s.id, s.slug]));

/** Prefer the configured STATIONS slug when the stop id matches — keeps
 * shorter / curated URLs for the main Frankfurt stops — else derive from name. */
export function slugForStop(stopIds: string[], stopName: string): string {
	for (const id of stopIds) {
		const slug = SLUG_BY_STOP_ID.get(id);
		if (slug) return slug;
	}
	return nameToSlug(stopName);
}

/** Icons for the buckets `normalize_category` emits (see
 * drizzle/20260811090000_normalize_category_fn). Every query hands us
 * normalized categories, so this is a straight bucket lookup — the old
 * per-glyph alias lists were a fourth copy of the normalization table
 * and had drifted from the SQL one.
 *
 * No Fernverkehr glyph: long-distance traffic is neither ingested nor
 * stored any more, so that bucket never reaches a card. Unknown buckets
 * get no glyph rather than a wrong one. */
const ICON_BY_CATEGORY: Record<string, string> = {
	Regionalverkehr: "🚆",
	"S-Bahn": "🚈",
	"U-Bahn": "🚇",
	Tram: "🚋",
	Bus: "🚌",
};

/** Ordered so a station served by several modes always renders its
 * glyphs fastest-first, regardless of category discovery order. */
const ICON_ORDER = ["Regionalverkehr", "S-Bahn", "U-Bahn", "Tram", "Bus"];

export function categoryIcons(categories: string[]): string {
	let icons = "";
	for (const bucket of ICON_ORDER) {
		if (categories.includes(bucket)) icons += ICON_BY_CATEGORY[bucket];
	}
	return icons;
}
