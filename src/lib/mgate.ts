export const MGATE_URL = "https://www.rmv.de/auskunft/bin/jp/mgate.exe";
export const AUTH = { type: "AID", aid: "uAWgheC24jhp6GdY" };
export const CLIENT = { id: "RMV", type: "WEB", name: "webapp", l: "vs_rmv" };

interface MgateStop {
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

interface MgateProduct {
	name?: string;
	line?: string;
	catOut?: string;
	operator?: string;
}

export interface MgateJourneyDetail {
	stops: MgateStop[];
	product?: MgateProduct;
	status?: string;
	lastPos?: { lat: number; lon: number };
	lastPosReported?: string;
	lastPassRouteIdx?: number;
	/** Route geometry as [lat, lon] pairs, already in WGS84 degrees. */
	polylinePoints?: [number, number][];
	dayOfOperation?: string;
	cancelled?: boolean;
	partCancelled?: boolean;
}

export type MgateResult =
	| { kind: "ok"; detail: MgateJourneyDetail }
	| { kind: "transient"; errCode: string | null }
	| { kind: "terminal"; errCode: string };

export interface MgateStationBoardEntry {
	journeyRef: string;
	dayOfOperation: string;
	line: string;
	category: string | null;
	operator: string | null;
	depTime: string;
	destName: string;
	cancelled: boolean;
	status: string | null;
}

export type MgateStationBoardResult =
	| { kind: "ok"; journeys: MgateStationBoardEntry[] }
	| { kind: "error"; errCode: string | null };

// Error codes we've observed from mgate that indicate a ref is permanently
// unusable. Everything else — including PARAMETER, which can flip back to OK
// on the very next call — is treated as transient so we don't burn the REST
// fallback on a single blip.
const TERMINAL_ERR_CODES = new Set(["LOCATION"]);

function parseTime(t?: string): string | undefined {
	if (!t || t.length < 6) return undefined;
	return `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
}

/**
 * HAFAS refs encode the service date as `DA#DDMMYY`. That's the
 * HAFAS-canonical operating day for the journey — which for overnight
 * routes can be the *prior* calendar day even though the trip happens
 * after midnight. Prefer this over the calendar date mgate sometimes
 * returns as `j.date` / `journey.date`, which for some responses is
 * the departure's calendar date instead.
 */
function parseServiceDateFromRef(ref: string): string | undefined {
	const m = /DA#(\d{2})(\d{2})(\d{2})/.exec(ref);
	if (!m) return undefined;
	const [, dd, mm, yy] = m;
	return `20${yy}-${mm}-${dd}`;
}

function parseYyyymmdd(s?: string): string | undefined {
	if (!s || s.length < 8) return undefined;
	return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Batch up to N journey-detail lookups into a single mgate POST. mgate's
 * `svcReqL` supports per-request error isolation, so one bad jid doesn't
 * fail the batch. Returns one MgateResult per input, in order.
 */
export async function mgateJourneyDetailsBatch(
	journeyIds: string[],
): Promise<MgateResult[]> {
	if (journeyIds.length === 0) return [];

	const body = {
		svcReqL: journeyIds.map((jid) => ({
			meth: "JourneyDetails",
			req: { jid, getPolyline: true },
		})),
		client: CLIENT,
		ver: "1.62",
		lang: "deu",
		auth: AUTH,
	};

	let resp: Response;
	try {
		resp = await fetch(MGATE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		return journeyIds.map(() => ({
			kind: "transient" as const,
			errCode: null,
		}));
	}

	if (!resp.ok)
		return journeyIds.map(() => ({
			kind: "transient" as const,
			errCode: `HTTP_${resp.status}`,
		}));

	const data = (await resp.json()) as { svcResL?: MgateSvcRes[] };
	const svcResL = data.svcResL ?? [];

	return journeyIds.map((jid, i) => parseJourneyDetailsRes(svcResL[i], jid));
}

interface MgateSvcRes {
	err?: string;
	res?: {
		common?: {
			locL?: {
				name: string;
				extId: string;
				crd?: { x: number; y: number };
			}[];
			prodL?: {
				name?: string;
				line?: string;
				catOut?: string;
				oprX?: number;
				prodCtx?: {
					catOut?: string;
					catOutL?: string;
					line?: string;
				};
			}[];
			opL?: { name: string }[];
			polyL?: {
				crd?: number[];
				crdEncYX?: string;
				crdEncS?: string;
				crdEncF?: string;
				delta?: boolean;
				dim?: number;
			}[];
		};
		journey?: {
			status?: string;
			stopL?: {
				locX: number;
				idx: number;
				dTimeS?: string;
				aTimeS?: string;
				dTimeR?: string;
				aTimeR?: string;
				cancelled?: boolean;
				dCncl?: boolean;
				aCncl?: boolean;
			}[];
			pos?: { x: number; y: number };
			posRep?: string;
			lastPassIdx?: number;
			polyG?: { polyXL?: number[] };
			date?: string;
			isCncl?: boolean;
			isPartCncl?: boolean;
		};
	};
}

function parseJourneyDetailsRes(
	svc: MgateSvcRes | undefined,
	ref: string,
): MgateResult {
	if (!svc) return { kind: "transient", errCode: null };
	if (svc.err && svc.err !== "OK") {
		const errCode = svc.err;
		return TERMINAL_ERR_CODES.has(errCode)
			? { kind: "terminal", errCode }
			: { kind: "transient", errCode };
	}

	const common = svc.res?.common;
	const journey = svc.res?.journey;
	if (!common || !journey) return { kind: "transient", errCode: "NO_DATA" };

	const locs = common.locL ?? [];
	const prods = common.prodL ?? [];
	const ops = common.opL ?? [];
	const polyL = common.polyL ?? [];

	const stops: MgateStop[] = (journey.stopL ?? []).map((s) => {
		const loc = locs[s.locX] ?? {};
		const crd = loc.crd ?? { x: 0, y: 0 };
		return {
			name: loc.name ?? "",
			extId: loc.extId ?? "",
			lat: crd.y / 1_000_000,
			lon: crd.x / 1_000_000,
			routeIdx: s.idx,
			depTime: parseTime(s.dTimeS),
			arrTime: parseTime(s.aTimeS),
			rtDepTime: parseTime(s.dTimeR),
			rtArrTime: parseTime(s.aTimeR),
			cancelled: s.cancelled || s.dCncl || s.aCncl,
		};
	});

	const prod = prods[0];
	const ctx = prod?.prodCtx;
	const product: MgateProduct | undefined = prod
		? {
				name: prod.name,
				line: ctx?.line ?? prod.line ?? prod.name,
				catOut: ctx?.catOutL?.trim() ?? ctx?.catOut?.trim() ?? prod.catOut,
				operator: prod.oprX != null ? ops[prod.oprX]?.name : undefined,
			}
		: undefined;

	const pos = journey.pos;
	const lastPos = pos
		? { lat: pos.y / 1_000_000, lon: pos.x / 1_000_000 }
		: undefined;

	const polyIdx = journey.polyG?.polyXL?.[0];
	const poly = polyIdx != null ? polyL[polyIdx] : polyL[0];
	const polylinePoints = poly ? decodePolyline(poly) : undefined;

	const dayOfOperation =
		parseServiceDateFromRef(ref) ?? parseYyyymmdd(journey.date);

	return {
		kind: "ok",
		detail: {
			stops,
			product,
			status: journey.status,
			lastPos,
			lastPosReported: journey.posRep,
			lastPassRouteIdx: journey.lastPassIdx,
			polylinePoints,
			dayOfOperation,
			cancelled: journey.isCncl,
			partCancelled: journey.isPartCncl,
		},
	};
}

/**
 * mgate returns polylines in one of two shapes depending on the client
 * profile: a raw `crd` number array (sometimes delta-encoded, integers
 * scaled by 1e6), or a Google-algorithm encoded `crdEncYX` string. This
 * handles both and always returns [lat, lon] pairs in WGS84 degrees.
 */
function decodePolyline(poly: {
	crd?: number[];
	crdEncYX?: string;
	delta?: boolean;
	dim?: number;
}): [number, number][] | undefined {
	if (poly.crdEncYX) return decodeEncodedPolyline(poly.crdEncYX);

	const dim = poly.dim ?? 2;
	if (!poly.crd || poly.crd.length < dim * 2) return undefined;
	const raw = poly.delta ? decodeDeltaCrd(poly.crd, dim) : poly.crd;
	const points: [number, number][] = [];
	for (let i = 0; i < raw.length; i += dim) {
		points.push([raw[i + 1] / 1_000_000, raw[i] / 1_000_000]);
	}
	return points;
}

function decodeDeltaCrd(encoded: number[], dim: number): number[] {
	const result: number[] = [];
	const acc = new Array(dim).fill(0);
	for (let i = 0; i < encoded.length; i += dim) {
		for (let d = 0; d < dim; d++) {
			acc[d] += encoded[i + d];
			result.push(acc[d]);
		}
	}
	return result;
}

/**
 * Standard Google-algorithm polyline decoder, lat-before-lon order.
 * Produces [lat, lon] degree pairs.
 */
export function decodeEncodedPolyline(str: string): [number, number][] {
	const factor = 1e5;
	let index = 0;
	let lat = 0;
	let lng = 0;
	const coords: [number, number][] = [];
	while (index < str.length) {
		let result = 1;
		let shift = 0;
		let b: number;
		do {
			b = str.charCodeAt(index++) - 63 - 1;
			result += b << shift;
			shift += 5;
		} while (b >= 0x1f);
		lat += result & 1 ? ~(result >> 1) : result >> 1;
		result = 1;
		shift = 0;
		do {
			b = str.charCodeAt(index++) - 63 - 1;
			result += b << shift;
			shift += 5;
		} while (b >= 0x1f);
		lng += result & 1 ? ~(result >> 1) : result >> 1;
		coords.push([lat / factor, lng / factor]);
	}
	return coords;
}

/**
 * Query StationBoard for many stations in one mgate POST. Returns one
 * result slot per input, in order, with per-station error isolation.
 *
 * `date`/`time` are HAFAS-native strings (YYYYMMDD / HHMMSS). `dur` is
 * the forward window in minutes.
 */
export async function mgateStationBoardBatch(
	stationIds: string[],
	opts: { date: string; time: string; durMinutes: number },
): Promise<MgateStationBoardResult[]> {
	if (stationIds.length === 0) return [];

	const body = {
		svcReqL: stationIds.map((extId) => ({
			meth: "StationBoard",
			req: {
				type: "DEP",
				stbLoc: { type: "S", extId },
				date: opts.date,
				time: opts.time,
				dur: opts.durMinutes,
				maxJny: 200,
			},
		})),
		client: CLIENT,
		ver: "1.62",
		lang: "deu",
		auth: AUTH,
	};

	let resp: Response;
	try {
		resp = await fetch(MGATE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		return stationIds.map(() => ({
			kind: "error" as const,
			errCode: null,
		}));
	}

	if (!resp.ok)
		return stationIds.map(() => ({
			kind: "error" as const,
			errCode: `HTTP_${resp.status}`,
		}));

	const data = (await resp.json()) as { svcResL?: MgateStbRes[] };
	const svcResL = data.svcResL ?? [];

	return stationIds.map((_, i) => parseStationBoardRes(svcResL[i]));
}

interface MgateStbRes {
	err?: string;
	res?: {
		common?: {
			prodL?: {
				name?: string;
				prodCtx?: {
					line?: string;
					catOut?: string;
					catOutL?: string;
				};
				oprX?: number;
			}[];
			opL?: { name: string }[];
		};
		jnyL?: {
			jid: string;
			prodX: number;
			date?: string;
			dirTxt?: string;
			isCncl?: boolean;
			status?: string;
			stbStop?: {
				dTimeS?: string;
				dTimeR?: string;
			};
		}[];
	};
}

function parseStationBoardRes(
	svc: MgateStbRes | undefined,
): MgateStationBoardResult {
	if (!svc) return { kind: "error", errCode: null };
	if (svc.err && svc.err !== "OK") return { kind: "error", errCode: svc.err };

	const common = svc.res?.common;
	const jnyL = svc.res?.jnyL ?? [];
	if (!common) return { kind: "ok", journeys: [] };

	const prods = common.prodL ?? [];
	const ops = common.opL ?? [];

	const journeys: MgateStationBoardEntry[] = [];
	for (const j of jnyL) {
		const prod = prods[j.prodX];
		const ctx = prod?.prodCtx;
		const line = ctx?.line ?? prod?.name;
		if (!line || !j.jid || !j.date) continue;

		// Prefer realtime dep time over scheduled when both are present.
		const rawTime = j.stbStop?.dTimeR ?? j.stbStop?.dTimeS;
		const depTime = parseTime(rawTime);
		if (!depTime) continue;

		const dayOfOperation =
			parseServiceDateFromRef(j.jid) ?? parseYyyymmdd(j.date);
		if (!dayOfOperation) continue;

		journeys.push({
			journeyRef: j.jid,
			dayOfOperation,
			line,
			category: ctx?.catOutL?.trim() ?? ctx?.catOut?.trim() ?? null,
			operator: prod?.oprX != null ? (ops[prod.oprX]?.name ?? null) : null,
			depTime,
			destName: j.dirTxt ?? "",
			cancelled: !!j.isCncl,
			status: j.status ?? null,
		});
	}

	return { kind: "ok", journeys };
}
