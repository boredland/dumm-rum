/**
 * KVV Mentz EFA client — Karlsruher Verkehrsverbund doesn't expose a
 * HAFAS mgate, but their EFA deployment at `projekte.kvv-efa.de/sl3-alone/`
 * speaks JSON when you append `&outputFormat=JSON` and serves two
 * endpoints we need:
 *
 *  - `XSLT_DM_REQUEST`  — per-stop departure monitor (discovery).
 *    Returns `departureList[]` with `servingLine.stateless` + `.key`
 *    and `realDateTime` when realtime data is flowing.
 *  - `XML_TRIPSTOPTIMES_REQUEST` — per-trip stop sequence (polling).
 *    Called with `line=<stateless>&tripCode=<key>&itdDate=<YYYYMMDD>`,
 *    returns `stopSeq[]` with scheduled + realtime datetimes and coords.
 *
 * Same data tier as our RMV HAFAS ingest — schedule with realtime
 * deltas, no vehicle GPS. INIT shut off the AVL vehicle feed in 2021.
 *
 * Synthetic `tripRef` format: `kvv|<stateless>|<tripCode>|<yyyymmdd>`.
 * Everything needed to re-fetch the trip is packed into the ref so the
 * pg-boss job payload stays minimal.
 */

export const KVV_EFA_BASE = "https://projekte.kvv-efa.de/sl3-alone";

export interface EfaStationBoardEntry {
	tripRef: string;
	dayOfOperation: string;
	line: string;
	category: string | null;
	operator: string | null;
	depTime: string;
	destName: string;
	stopId: string;
	cancelled: boolean;
	status: string | null;
}

export type EfaStationBoardResult =
	| { kind: "ok"; departures: EfaStationBoardEntry[] }
	| { kind: "error"; errCode: string | null };

export interface EfaStop {
	name: string;
	extId: string;
	lat: number;
	lon: number;
	routeIdx: number;
	depTime?: string;
	arrTime?: string;
	rtDepTime?: string;
	rtArrTime?: string;
	cancelled?: boolean;
}

export interface EfaProduct {
	name?: string;
	line?: string;
	catOut?: string;
	operator?: string;
}

export interface EfaTripDetail {
	stops: EfaStop[];
	product?: EfaProduct;
	status?: string;
	cancelled?: boolean;
}

export type EfaResult =
	| { kind: "ok"; detail: EfaTripDetail }
	| { kind: "transient"; errCode: string | null }
	| { kind: "terminal"; errCode: string };

export function encodeTripRef(
	stateless: string,
	tripCode: string,
	yyyymmdd: string,
): string {
	return `kvv|${stateless}|${tripCode}|${yyyymmdd}`;
}

export function decodeTripRef(
	ref: string,
): { stateless: string; tripCode: string; yyyymmdd: string } | null {
	if (!ref.startsWith("kvv|")) return null;
	// stateless contains colons but no pipes, so the pipe separator is
	// safe. Always 4 tokens: kvv | stateless | tripCode | yyyymmdd.
	const parts = ref.split("|");
	if (parts.length !== 4) return null;
	const [, stateless, tripCode, yyyymmdd] = parts;
	if (!stateless || !tripCode || !yyyymmdd) return null;
	return { stateless, tripCode, yyyymmdd };
}

/** Map EFA `product` / `servingLine.name` values to the category
 * strings the livemap colour table + `categoryIcons()` understand.
 * EFA is inconsistent about which field carries the product name —
 * `servingLine.name` can be "S", "Straßenbahn", "Regional-Bahn" or a
 * full route code depending on the operator — so we also match on
 * substring prefixes. Unknown strings fall back to "Other" rather than
 * passthrough, which would leave them uncoloured on the livemap. */
export function normalizeEfaCategory(raw: string | undefined): string | null {
	if (!raw) return null;
	const p = raw.trim();
	if (p === "Straßenbahn" || p === "Einsatzwagen" || p === "Tram")
		return "Tram";
	if (p === "Stadtbahn" || p === "U-Bahn") return "U-Bahn";
	if (p === "S-Bahn" || p === "S" || /^S\d/.test(p)) return "S-Bahn";
	if (
		p === "Bus" ||
		p === "Stadtbus" ||
		p === "Regionalbus" ||
		p === "Schnellbus"
	)
		return "Bus";
	if (
		p === "Regional-Bahn" ||
		p === "Regionalbahn" ||
		p === "R-Bahn" ||
		p === "R" ||
		/^(RB|RE|IRE)\b/.test(p)
	)
		return "Regionalverkehr";
	if (
		p === "Fernverkehr" ||
		p === "Intercity-Express" ||
		p === "Intercity" ||
		p === "Eurocity" ||
		p === "Nightjet" ||
		p === "Railjet" ||
		p === "Railjet Xpress" ||
		p === "D-Zug" ||
		p === "Fernzug" ||
		/^(ICE|ICE-Sprinter|IC|EC|ECE|NJ|EN|RJ|RJX|TGV|EST)\b/.test(p)
	)
		return "Fernverkehr";
	if (p === "AST") return "AST";
	if (p === "Schiff" || p === "Fähre") return "Ferry";
	return "Other";
}

/** EFA gives us `{year:"2026", month:"4", day:"19", hour:"12", minute:"3"}`
 * — unpadded. Two zero-padded strings out: a `YYYY-MM-DD` date and a
 * `HH:MM:SS` time (seconds are always 00 — EFA resolution is minute). */
function parseEfaDateTime(dt: {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
}): { date: string; time: string } {
	const pad = (s: string) => s.padStart(2, "0");
	return {
		date: `${dt.year}-${pad(dt.month)}-${pad(dt.day)}`,
		time: `${pad(dt.hour)}:${pad(dt.minute)}:00`,
	};
}

/** EFA emits `"20260419 12:58"` and `"20260419 12:58:24"` in `arrDateTime` /
 * `arrDateTimeSec`. We normalize to `HH:MM:SS` for storage (matching RMV).
 * Seconds form is preferred when present — avoids a silent 0-second
 * when real arrivals are mid-minute. */
function parseEfaTripTime(
	dt?: string,
	dtSec?: string,
): { yyyymmdd: string; time: string } | undefined {
	const src = dtSec && dtSec.length >= 17 ? dtSec : dt;
	if (!src) return undefined;
	const m = /^(\d{8})\s+(\d{2}:\d{2})(?::(\d{2}))?$/.exec(src);
	if (!m) return undefined;
	const [, yyyymmdd, hhmm, ss] = m;
	return { yyyymmdd, time: `${hhmm}:${ss ?? "00"}` };
}

/** HH:MM:SS if the stop is today, else null. Spanning midnight is rare
 * for Karlsruhe trams/buses (few nightliners); we keep the date check
 * strict so an overnight trip's past-midnight stops don't get written
 * as if they were same-day. Callers can still see the stop itself was
 * polled — it just won't contribute to dayOfOperation stats. */
function sameDayTime(
	parsed: { yyyymmdd: string; time: string } | undefined,
	yyyymmdd: string,
): string | undefined {
	if (!parsed) return undefined;
	return parsed.yyyymmdd === yyyymmdd ? parsed.time : undefined;
}

function yyyymmddDashed(yyyymmdd: string): string {
	return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function rtTime(
	sched: { yyyymmdd: string; time: string } | undefined,
	delayMin: string | undefined,
	valid: string | undefined,
): { yyyymmdd: string; time: string } | undefined {
	// EFA encodes "no realtime observed" as delay=0 + valid=0 — distinct
	// from "observed, on time" (delay=0 + valid=1). Skipping the former
	// keeps rt_dep_time / rt_arr_time genuinely null when there's no
	// upstream signal, matching RMV semantics.
	if (!sched || valid !== "1") return undefined;
	const delay = Number(delayMin ?? "0");
	if (!Number.isFinite(delay)) return undefined;
	if (delay === 0) return sched;
	const [h, m, s] = sched.time.split(":").map(Number);
	const total = h * 60 + m + delay;
	const rh = Math.floor(total / 60);
	const overflow = Math.floor(rh / 24);
	const hh = String(rh % 24).padStart(2, "0");
	const mm = String(total % 60).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	if (overflow === 0)
		return { yyyymmdd: sched.yyyymmdd, time: `${hh}:${mm}:${ss}` };
	// Crossed midnight — bump the date string.
	const d = new Date(
		Date.UTC(
			Number(sched.yyyymmdd.slice(0, 4)),
			Number(sched.yyyymmdd.slice(4, 6)) - 1,
			Number(sched.yyyymmdd.slice(6, 8)) + overflow,
		),
	);
	const y = d.getUTCFullYear();
	const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
	const da = String(d.getUTCDate()).padStart(2, "0");
	return { yyyymmdd: `${y}${mo}${da}`, time: `${hh}:${mm}:${ss}` };
}

/** Known EFA short-term error messages we can't recover from for a
 * given trip — wrong tripCode/line combo, expired schedule, etc. Every
 * non-match falls into "transient" so one bad response doesn't retire
 * a run. Matches the mgate.ts strategy. */
const TERMINAL_EFA_ERRORS = new Set(["no_stops", "invalid_trip"]);

async function efaGet(
	path: string,
	params: Record<string, string>,
): Promise<Response> {
	const usp = new URLSearchParams({ outputFormat: "JSON", ...params });
	return fetch(`${KVV_EFA_BASE}/${path}?${usp.toString()}`, {
		headers: { Accept: "application/json" },
	});
}

/** Fetch a single stop's departure monitor. EFA is per-stop; we call it
 * in parallel from the discover cron (one HTTP per configured station).
 * `limit` clamps how many departures per stop — EFA defaults to 40.
 * Dup-proof against overlapping cron runs via journey_runs' composite
 * primary key + ON CONFLICT DO NOTHING at the caller. */
export async function efaStationBoard(
	stopId: string,
	opts: { date: string; time: string; limit?: number },
): Promise<EfaStationBoardResult> {
	const params: Record<string, string> = {
		coordOutputFormat: "WGS84[dd.ddddd]",
		depType: "stopEvents",
		locationServerActive: "1",
		mode: "direct",
		name_dm: stopId,
		type_dm: "stop",
		useOnlyStops: "1",
		useRealtime: "1",
		itdDate: opts.date,
		itdTime: opts.time,
		limit: String(opts.limit ?? 40),
	};

	let resp: Response;
	try {
		resp = await efaGet("XSLT_DM_REQUEST", params);
	} catch {
		return { kind: "error", errCode: null };
	}
	if (!resp.ok) return { kind: "error", errCode: `HTTP_${resp.status}` };

	const data = (await resp.json()) as EfaDmResponse;
	const list = data.departureList;
	if (!Array.isArray(list)) return { kind: "ok", departures: [] };

	const departures: EfaStationBoardEntry[] = [];
	for (const dep of list) {
		const sl = dep.servingLine;
		if (!sl?.stateless || !sl.key) continue;
		const when = parseEfaDateTime(dep.dateTime);
		const yyyymmdd = when.date.replace(/-/g, "");
		departures.push({
			tripRef: encodeTripRef(sl.stateless, sl.key, yyyymmdd),
			dayOfOperation: when.date,
			line: sl.number ?? sl.symbol ?? "",
			category: normalizeEfaCategory(sl.name),
			operator: dep.operator?.publicCode ?? dep.operator?.name ?? null,
			depTime: when.time,
			destName: sl.direction ?? "",
			stopId,
			cancelled: dep.realtimeTripStatus === "TRIP_CANCELED",
			status: dep.realtimeTripStatus ?? null,
		});
	}
	return { kind: "ok", departures };
}

/** Fetch one trip's full stop sequence from a `tripRef`. The ref
 * decodes into (stateless, tripCode, date) — enough to re-request
 * XML_TRIPSTOPTIMES_REQUEST deterministically. Returns normalized
 * `EfaTripDetail` matching `MgateJourneyDetail` in shape so the poller
 * can share logic. */
export async function efaTripDetail(tripRef: string): Promise<EfaResult> {
	const decoded = decodeTripRef(tripRef);
	if (!decoded) return { kind: "terminal", errCode: "BAD_REF" };

	const params: Record<string, string> = {
		coordOutputFormat: "WGS84[dd.ddddd]",
		line: decoded.stateless,
		tripCode: decoded.tripCode,
		itdDate: decoded.yyyymmdd,
		useRealtime: "1",
	};

	let resp: Response;
	try {
		resp = await efaGet("XML_TRIPSTOPTIMES_REQUEST", params);
	} catch {
		return { kind: "transient", errCode: null };
	}
	if (!resp.ok) return { kind: "transient", errCode: `HTTP_${resp.status}` };

	const data = (await resp.json()) as EfaTstResponse;
	const seq = data.stopSeq;
	if (!Array.isArray(seq) || seq.length < 2) {
		return TERMINAL_EFA_ERRORS.has("no_stops")
			? { kind: "terminal", errCode: "no_stops" }
			: { kind: "transient", errCode: "no_stops" };
	}

	const stops: EfaStop[] = [];
	for (let i = 0; i < seq.length; i++) {
		const s = seq[i];
		const r = s.ref;
		if (!r) continue;
		const dep = parseEfaTripTime(r.depDateTime, r.depDateTimeSec);
		const arr = parseEfaTripTime(r.arrDateTime, r.arrDateTimeSec);
		const rtDep = rtTime(dep, r.depDelay, r.depValid);
		const rtArr = rtTime(arr, r.arrDelay, r.arrValid);
		const [lonStr, latStr] = (r.coords ?? "0,0").split(",");
		stops.push({
			name: s.name ?? "",
			extId: r.id ?? "",
			lat: Number(latStr) || 0,
			lon: Number(lonStr) || 0,
			routeIdx: i,
			depTime: sameDayTime(dep, decoded.yyyymmdd),
			arrTime: sameDayTime(arr, decoded.yyyymmdd),
			rtDepTime: sameDayTime(rtDep, decoded.yyyymmdd),
			rtArrTime: sameDayTime(rtArr, decoded.yyyymmdd),
			cancelled: false,
		});
	}

	const mode = data.mode;
	const product: EfaProduct | undefined = mode
		? {
				name: mode.name,
				line: mode.number ?? mode.symbol,
				catOut: normalizeEfaCategory(mode.product) ?? undefined,
				operator: mode.diva?.opPublicCode ?? mode.diva?.operator,
			}
		: undefined;

	return {
		kind: "ok",
		detail: {
			stops,
			product,
			status: mode?.realtime === "1" ? "MONITORED" : undefined,
			cancelled: false,
		},
	};
}

// ---------- raw EFA response shapes (only fields we read) ----------

interface EfaDateTime {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
}

interface EfaServingLine {
	stateless?: string;
	key?: string;
	number?: string;
	symbol?: string;
	name?: string;
	direction?: string;
}

interface EfaDeparture {
	stopID?: string;
	dateTime: EfaDateTime;
	realDateTime?: EfaDateTime;
	realtimeTripStatus?: string;
	servingLine?: EfaServingLine;
	operator?: { publicCode?: string; name?: string };
}

interface EfaDmResponse {
	departureList?: EfaDeparture[];
}

interface EfaStopRef {
	id?: string;
	platform?: string;
	coords?: string;
	arrDateTime?: string;
	arrDateTimeSec?: string;
	depDateTime?: string;
	depDateTimeSec?: string;
	arrDelay?: string;
	arrValid?: string;
	depDelay?: string;
	depValid?: string;
}

interface EfaStopSeqEntry {
	name?: string;
	ref?: EfaStopRef;
}

interface EfaMode {
	name?: string;
	number?: string;
	symbol?: string;
	product?: string;
	realtime?: string;
	diva?: {
		opPublicCode?: string;
		operator?: string;
	};
}

interface EfaTstResponse {
	mode?: EfaMode;
	stopSeq?: EfaStopSeqEntry[];
}

// yyyymmddDashed is referenced from discover.ts for logging — keep it
// exported close to the producer even if currently unused here.
export { yyyymmddDashed };

// ---------- polyline fetching (XSLT_TRIP_REQUEST2) ----------

/** In-process L1 cache. Key = `<stateless>`. Shapes barely change for
 * the life of a schedule period (year or two), so eviction isn't a
 * concern for a long-running worker process. Same pattern as the
 * bahn.expert polyline L1 in `src/lib/bahn-expert.ts`. */
const shapeL1 = new Map<string, [number, number][]>();

export function shapeCacheKey(stateless: string): string {
	return `kvv:shape:${stateless}`;
}

export function shapeFromL1(stateless: string): [number, number][] | undefined {
	return shapeL1.get(stateless);
}

export function shapeToL1(stateless: string, points: [number, number][]): void {
	shapeL1.set(stateless, points);
}

/** Decode EFA's `"lon,lat lon,lat ..."` space-separated path string
 * into `[lat, lon][]` — the shape the rest of the codebase
 * (gps-path.ts) uses for interpolation. `leg.format` is always "x,y"
 * (= lon,lat) in Mentz EFA, so no need to look it up. Silently drops
 * malformed tokens instead of failing the whole shape. */
function parseEfaPath(path: string): [number, number][] {
	const out: [number, number][] = [];
	for (const token of path.split(/\s+/)) {
		if (!token) continue;
		const [lonStr, latStr] = token.split(",");
		const lon = Number(lonStr);
		const lat = Number(latStr);
		if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
	}
	return out;
}

/**
 * Fetch the geometry of a given line direction via the trip planner.
 * EFA doesn't expose a "give me the polyline for this line" endpoint,
 * but `XSLT_TRIP_REQUEST2` with `includeShape=1` returns a space-
 * separated `lon,lat` string in `leg.path` for each transit leg.
 * Asking the planner for a direct A→B trip on the line's origin and
 * destination stops yields exactly the single leg we care about;
 * filtering by `mode.diva.stateless` keeps us honest if the planner
 * routes via a different line as a fallback.
 *
 * Shapes are stable across the schedule period, so callers should
 * cache on the `stateless` key and re-use for every trip of the line.
 *
 * `originId`/`destinationId` are the first/last stop IDs of the
 * already-fetched trip (see `efaTripDetail` → `stops[0].extId`,
 * `stops[len-1].extId`).
 */
export async function efaTripShape(opts: {
	stateless: string;
	originId: string;
	destinationId: string;
	yyyymmdd: string;
	hhmm: string;
}): Promise<[number, number][] | null> {
	const params: Record<string, string> = {
		coordOutputFormat: "WGS84[dd.ddddd]",
		sessionID: "0",
		language: "de",
		type_origin: "any",
		name_origin: opts.originId,
		type_destination: "any",
		name_destination: opts.destinationId,
		itdDate: opts.yyyymmdd,
		itdTime: opts.hhmm,
		useRealtime: "1",
		calcNumberOfTrips: "1",
		routeType: "LEASTTIME",
		ptOptionsActive: "1",
		includeShape: "1",
		shapeMap: "WGS84[dd.ddddd]",
		coordListOutputFormat: "STRING",
		genMaps: "0",
	};

	let resp: Response;
	try {
		resp = await efaGet("XSLT_TRIP_REQUEST2", params);
	} catch {
		return null;
	}
	if (!resp.ok) return null;

	const data = (await resp.json()) as EfaTripResponse;
	const tripOrTrips = data.trips?.trip;
	if (!tripOrTrips) return null;
	const trip = Array.isArray(tripOrTrips) ? tripOrTrips[0] : tripOrTrips;

	const legs = trip?.legs ?? [];
	// Prefer the leg that actually matches the line we asked about; fall
	// back to any leg with a `path` so a schedule glitch doesn't return
	// a stubbornly empty shape.
	const targetLeg =
		legs.find((l) => l.mode?.diva?.stateless === opts.stateless && l.path) ??
		legs.find((l) => l.path);

	if (!targetLeg?.path) return null;
	const pts = parseEfaPath(targetLeg.path);
	return pts.length > 0 ? pts : null;
}

interface EfaLeg {
	mode?: {
		diva?: { stateless?: string };
	};
	path?: string;
	format?: string;
}

interface EfaTripResponse {
	trips?: {
		trip?: { legs?: EfaLeg[] } | Array<{ legs?: EfaLeg[] }>;
	};
}
