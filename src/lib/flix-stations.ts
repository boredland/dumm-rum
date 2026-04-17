/**
 * Flix (FlixBus + FlixTrain) stations in / near the RMV service area.
 *
 * Flix assigns separate UUIDs to bus and train stops even at the same
 * physical station, so both must be enumerated where they exist. UUIDs
 * resolved via `flixAutocompleteStations` (one-shot) on 2026-04-17.
 *
 * Omitted: Frankfurt (Main) Hbf (train) — exists but currently returns
 * only DB Regio rides. Omitted: Frankfurt (Main) Niederrad — negligible
 * Flix traffic.
 */

export interface FlixStationEntry {
	uuid: string;
	name: string;
	lat: number;
	lon: number;
	isTrain: boolean;
}

export const FLIX_STATIONS: FlixStationEntry[] = [
	{
		uuid: "dcbabe0c-9603-11e6-9066-549f350fcb0c",
		name: "Frankfurt Hbf",
		lat: 50.104394,
		lon: 8.662577,
		isTrain: false,
	},
	{
		uuid: "cd27dc81-a5a0-42f2-8662-650411b4a7e7",
		name: "Frankfurt (Main) Süd",
		lat: 50.099857,
		lon: 8.685935,
		isTrain: true,
	},
	{
		uuid: "dcbadca1-9603-11e6-9066-549f350fcb0c",
		name: "Frankfurt Flughafen",
		lat: 50.052682,
		lon: 8.57749,
		isTrain: false,
	},
	{
		uuid: "92112718-d515-4f91-a6ee-61fc2dd5ac74",
		name: "Frankfurt Flughafen Fernbahnhof",
		lat: 50.052875,
		lon: 8.569751,
		isTrain: true,
	},
	{
		uuid: "dcbabf60-9603-11e6-9066-549f350fcb0c",
		name: "Darmstadt Hbf (bus)",
		lat: 49.8709188,
		lon: 8.6286074,
		isTrain: false,
	},
	{
		uuid: "06cc0192-fc4c-4488-9aa9-dc27758bbbf2",
		name: "Darmstadt Hbf",
		lat: 49.872516,
		lon: 8.629379,
		isTrain: true,
	},
	{
		uuid: "dcbb7f98-9603-11e6-9066-549f350fcb0c",
		name: "Mainz Hbf (bus)",
		lat: 50.000435,
		lon: 8.258504,
		isTrain: false,
	},
	{
		uuid: "568dcd9d-d58a-4872-9161-1a8e213c4278",
		name: "Mainz Hbf",
		lat: 50.001317,
		lon: 8.258583,
		isTrain: true,
	},
	{
		uuid: "dcbba9d9-9603-11e6-9066-549f350fcb0c",
		name: "Wiesbaden Hbf (bus)",
		lat: 50.070865,
		lon: 8.246166,
		isTrain: false,
	},
	{
		uuid: "263d0f5a-2b75-4010-893c-47f2df9f44b6",
		name: "Wiesbaden Hbf",
		lat: 50.0704,
		lon: 8.24387,
		isTrain: true,
	},
	{
		uuid: "95f592e5-e4bc-4843-97ed-17a9001b030f",
		name: "Hanau Hbf",
		lat: 50.121508,
		lon: 8.929718,
		isTrain: true,
	},
	{
		uuid: "8b67b5f7-4749-4a54-b26d-cb2c4257fcee",
		name: "Offenbach (Main) Hbf",
		lat: 50.099264,
		lon: 8.760743,
		isTrain: true,
	},
];
