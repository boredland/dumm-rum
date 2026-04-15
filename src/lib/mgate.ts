const MGATE_URL = "https://www.rmv.de/auskunft/bin/jp/mgate.exe";
const AUTH = { type: "AID", aid: "uAWgheC24jhp6GdY" };
const CLIENT = { id: "RMV", type: "WEB", name: "webapp", l: "vs_rmv" };

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
	polylineCrd?: number[];
	polylineDelta?: boolean;
	polylineDim?: number;
	dayOfOperation?: string;
	cancelled?: boolean;
	partCancelled?: boolean;
}

export type MgateResult =
	| { kind: "ok"; detail: MgateJourneyDetail }
	| { kind: "transient"; errCode: string | null }
	| { kind: "terminal"; errCode: string };

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

	const data = await resp.json<{ svcResL?: MgateSvcRes[] }>();
	const svcResL = data.svcResL ?? [];

	return journeyIds.map((_, i) => parseJourneyDetailsRes(svcResL[i]));
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

function parseJourneyDetailsRes(svc: MgateSvcRes | undefined): MgateResult {
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

	let polylineCrd: number[] | undefined;
	let polylineDelta: boolean | undefined;
	let polylineDim: number | undefined;
	const polyIdx = journey.polyG?.polyXL?.[0];
	const poly = polyIdx != null ? polyL[polyIdx] : polyL[0];
	if (poly?.crd) {
		polylineCrd = poly.crd;
		polylineDelta = poly.delta;
		polylineDim = poly.dim ?? 2;
	}

	const dateRaw = journey.date;
	const dayOfOperation = dateRaw
		? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`
		: undefined;

	return {
		kind: "ok",
		detail: {
			stops,
			product,
			status: journey.status,
			lastPos,
			lastPosReported: journey.posRep,
			lastPassRouteIdx: journey.lastPassIdx,
			polylineCrd,
			polylineDelta,
			polylineDim,
			dayOfOperation,
			cancelled: journey.isCncl,
			partCancelled: journey.isPartCncl,
		},
	};
}
