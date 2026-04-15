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
