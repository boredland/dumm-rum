/**
 * KVV (Karlsruher Verkehrsverbund) station list. KVV stop IDs are the
 * Mentz EFA 7-digit form (7000xxx — Karlsruhe namespace), distinct from
 * RMV's 3000xxx space. The discovery cron fans a DM call out to each
 * entry here; poll jobs re-hit the EFA backend for per-trip stop times.
 */
import type { Station } from "./stations.ts";

export const KVV_STATIONS: Station[] = [
	{ id: "7000090", name: "Karlsruhe Hauptbahnhof", slug: "kvv-hauptbahnhof" },
	{
		id: "7001003",
		name: "Karlsruhe Marktplatz (Kaiserstraße U)",
		slug: "kvv-marktplatz",
	},
	{
		id: "7001011",
		name: "Karlsruhe Marktplatz (Pyramide U)",
		slug: "kvv-pyramide",
	},
	{ id: "7003001", name: "Durlach Bahnhof", slug: "kvv-durlach-bahnhof" },
	{ id: "7000501", name: "Karlsruhe Rheinhafen", slug: "kvv-rheinhafen" },
	{
		id: "7000120",
		name: "Karlsruhe Europaplatz (Kaiserstraße U)",
		slug: "kvv-europaplatz",
	},
	{ id: "7000239", name: "Karlsruhe Siemensallee", slug: "kvv-siemensallee" },
	{ id: "7003500", name: "Wolfartsweier Nord", slug: "kvv-wolfartsweier-nord" },
];
