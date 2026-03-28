export interface Station {
	id: string;
	name: string;
	slug: string;
	type: "bus" | "tram" | "underground";
	collectionStart: string;
	collectionStartTime: string;
}

export const STATIONS: Station[] = [
	{
		id: "3001586",
		name: "Frankfurt (Main) Draisbornstraße",
		slug: "draisbornstrasse",
		type: "bus",
		collectionStart: "2026-03-27",
		collectionStartTime: "11:00:00",
	},
	{
		id: "3000508",
		name: "Frankfurt (Main) Rothschildallee",
		slug: "rothschildallee",
		type: "tram",
		collectionStart: "2026-03-27",
		collectionStartTime: "17:00:00",
	},
	{
		id: "3000506",
		name: "Frankfurt (Main) Matthias-Beltz-Platz",
		slug: "matthias-beltz-platz",
		type: "tram",
		collectionStart: "2026-03-27",
		collectionStartTime: "19:00:00",
	},
	{
		id: "3001209",
		name: "Frankfurt (Main) Philipp-Reis-Straße",
		slug: "philipp-reis-strasse",
		type: "bus",
		collectionStart: "2026-03-27",
		collectionStartTime: "20:00:00",
	},
	{
		id: "3000129",
		name: "Frankfurt (Main) Leonardo-Da-Vinci-Allee",
		slug: "leonardo-da-vinci-allee",
		type: "bus",
		collectionStart: "2026-03-27",
		collectionStartTime: "20:00:00",
	},
	{
		id: "3000502",
		name: "Frankfurt (Main) Höhenstraße",
		slug: "hoehenstrasse",
		type: "underground",
		collectionStart: "2026-03-27",
		collectionStartTime: "19:00:00",
	},
	{
		id: "3001545",
		name: "Frankfurt (Main) Seckbacher Landstraße",
		slug: "seckbacher-landstrasse",
		type: "underground",
		collectionStart: "2026-03-27",
		collectionStartTime: "18:00:00",
	},
];

export function findStation(slug: string): Station | undefined {
	return STATIONS.find((s) => s.slug === slug);
}

export function stationIcon(type: Station["type"]): string {
	return type === "underground" ? "🚇" : type === "tram" ? "🚋" : "🚌";
}
