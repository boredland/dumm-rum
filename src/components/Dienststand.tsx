import { createServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
	type DienststandData,
	loadDienststand,
} from "../lib/dienststand.ts";
import { type Lang, t } from "../lib/i18n.ts";

const fetchDienststand = createServerFn({ method: "GET" }).handler(
	async (): Promise<DienststandData> => loadDienststand(),
);

const POLL_MS = 60_000;
const BERLIN_TIME_OPTS: Intl.DateTimeFormatOptions = {
	timeZone: "Europe/Berlin",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
};

type Health = "nominal" | "lag" | "stale" | "unknown";

function deriveHealth(lastSnapshotIso: string | null): Health {
	if (!lastSnapshotIso) return "unknown";
	const age = Date.now() - new Date(lastSnapshotIso).getTime();
	if (!Number.isFinite(age)) return "unknown";
	if (age < 3 * 60_000) return "nominal";
	if (age < 10 * 60_000) return "lag";
	return "stale";
}

const HEALTH_META = {
	nominal: {
		glyph: "A",
		tone: "led-text-ok",
		labelKey: "dienststand.nominal",
	},
	lag: { glyph: "W", tone: "led-text-warn", labelKey: "dienststand.lag" },
	stale: {
		glyph: "X",
		tone: "led-text-danger",
		labelKey: "dienststand.stale",
	},
	unknown: {
		glyph: "—",
		tone: "text-dimmed",
		labelKey: "dienststand.unknown",
	},
} as const satisfies Record<
	Health,
	{ glyph: string; tone: string; labelKey: string }
>;

export function Dienststand({ lang }: { lang: Lang }) {
	const [now, setNow] = useState<string>("--:--:--");
	const [data, setData] = useState<DienststandData | null>(null);

	useEffect(() => {
		const tick = () =>
			setNow(new Date().toLocaleTimeString("de-DE", BERLIN_TIME_OPTS));
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		let cancelled = false;
		const fetchOnce = async () => {
			try {
				const d = await fetchDienststand();
				if (!cancelled) setData(d);
			} catch {
				// Network hiccup — leave last-known value in place.
			}
		};
		fetchOnce();
		const id = setInterval(fetchOnce, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	const health = deriveHealth(data?.lastSnapshot ?? null);
	const meta = HEALTH_META[health];
	const trackedFmt =
		data === null
			? "—"
			: data.trackedToday.toLocaleString(lang === "de" ? "de-DE" : "en-US");

	return (
		<div className="bg-signage border-b border-black/60 text-white">
			<div className="mx-auto max-w-5xl px-4 py-1.5 flex items-center gap-4 text-micro uppercase font-black">
				<span className="tabular-nums led-text-ok">{now}</span>
				<span className="text-white/20">·</span>
				<span className="flex-1 truncate text-white/70">
					<span className="tabular-nums text-white font-black mr-1">
						{trackedFmt}
					</span>
					{t(lang, "dienststand.tracked_today")}
				</span>
				<span className="flex items-center gap-2 shrink-0">
					<span
						className={`${meta.tone} font-black tabular-nums w-4 text-center`}
						aria-hidden
					>
						{meta.glyph}
					</span>
					<span className="hidden sm:inline text-white/70">
						{t(lang, meta.labelKey)}
					</span>
				</span>
			</div>
		</div>
	);
}
