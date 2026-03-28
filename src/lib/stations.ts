export interface Station {
	id: string;
	name: string;
	slug: string;
	type: "bus" | "tram" | "underground";
}

export const STATIONS: Station[] = [
	{
		id: "3001586",
		name: "Frankfurt (Main) Draisbornstraße",
		slug: "draisbornstrasse",
		type: "bus",
	},
	{
		id: "3000508",
		name: "Frankfurt (Main) Rothschildallee",
		slug: "rothschildallee",
		type: "tram",
	},
	{
		id: "3000506",
		name: "Frankfurt (Main) Matthias-Beltz-Platz",
		slug: "matthias-beltz-platz",
		type: "tram",
	},
	{
		id: "3001209",
		name: "Frankfurt (Main) Philipp-Reis-Straße",
		slug: "philipp-reis-strasse",
		type: "bus",
	},
	{
		id: "3000129",
		name: "Frankfurt (Main) Leonardo-Da-Vinci-Allee",
		slug: "leonardo-da-vinci-allee",
		type: "bus",
	},
	{
		id: "3000502",
		name: "Frankfurt (Main) Höhenstraße",
		slug: "hoehenstrasse",
		type: "underground",
	},
	{
		id: "3001545",
		name: "Frankfurt (Main) Seckbacher Landstraße",
		slug: "seckbacher-landstrasse",
		type: "underground",
	},
	{
		id: "3000510",
		name: "Frankfurt (Main) Konstablerwache",
		slug: "konstablerwache",
		type: "bus",
	},
	{
		id: "3001217",
		name: "Frankfurt (Main) Rödelheim Bahnhof",
		slug: "roedelheim-bahnhof",
		type: "bus",
	},
	{
		id: "3001606",
		name: "Frankfurt (Main) Buchrainplatz",
		slug: "buchrainplatz",
		type: "bus",
	},
	{
		id: "3011073",
		name: "Frankfurt (Main) Zeilsheim Bahnhof",
		slug: "zeilsheim-bahnhof",
		type: "bus",
	},
];

export function findStation(slug: string): Station | undefined {
	return STATIONS.find((s) => s.slug === slug);
}

export function stationIcon(type: Station["type"]): string {
	return type === "underground" ? "🚇" : type === "tram" ? "🚋" : "🚌";
}
