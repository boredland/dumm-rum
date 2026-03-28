export interface Station {
	id: string;
	name: string;
	slug: string;
}

export const STATIONS: Station[] = [
	{
		id: "3001586",
		name: "Frankfurt (Main) Draisbornstraße",
		slug: "draisbornstrasse",
	},
	{
		id: "3000508",
		name: "Frankfurt (Main) Rothschildallee",
		slug: "rothschildallee",
	},
	{
		id: "3000506",
		name: "Frankfurt (Main) Matthias-Beltz-Platz",
		slug: "matthias-beltz-platz",
	},
	{
		id: "3001209",
		name: "Frankfurt (Main) Philipp-Reis-Straße",
		slug: "philipp-reis-strasse",
	},
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
		id: "3001545",
		name: "Frankfurt (Main) Seckbacher Landstraße",
		slug: "seckbacher-landstrasse",
	},
	{
		id: "3000510",
		name: "Frankfurt (Main) Konstablerwache",
		slug: "konstablerwache",
	},
	{
		id: "3001217",
		name: "Frankfurt (Main) Rödelheim Bahnhof",
		slug: "roedelheim-bahnhof",
	},
	{
		id: "3001606",
		name: "Frankfurt (Main) Buchrainplatz",
		slug: "buchrainplatz",
	},
	{
		id: "3011073",
		name: "Frankfurt (Main) Zeilsheim Bahnhof",
		slug: "zeilsheim-bahnhof",
	},
	{
		id: "3007011",
		name: "Frankfurt (Main) Hauptbahnhof Südseite",
		slug: "hauptbahnhof-suedseite",
	},
	{
		id: "3001507",
		name: "Frankfurt (Main) Bornheim Mitte",
		slug: "bornheim-mitte",
	},
	{
		id: "3001008",
		name: "Frankfurt (Main) Höchst Bahnhof",
		slug: "hoechst-bahnhof",
	},
];

export function findStation(slug: string): Station | undefined {
	return STATIONS.find((s) => s.slug === slug);
}

export function categoryIcons(categories: string[]): string {
	const icons: string[] = [];
	if (categories.includes("U-Bahn")) icons.push("🚇");
	if (categories.includes("Tram")) icons.push("🚋");
	if (categories.includes("Bus")) icons.push("🚌");
	return icons.join("");
}
