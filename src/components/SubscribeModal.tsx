import { useEffect, useMemo, useState } from "react";
import { type Lang, t } from "../lib/i18n.ts";
import { buildSubscribeUrl } from "../lib/telegram-deeplink.ts";
import { Combobox } from "./Combobox.tsx";

/** In-memory process-wide cache so every SubscribeModal mount across a
 * session reuses the same picker fetches. Lists are stable for minutes —
 * `/api/picker/*` is cached upstream at 1h browser + 1d CDN, we just
 * dedupe concurrent modal mounts here. */
type PickerKind = "stops" | "lines" | "directions";
const pickerCache: Partial<Record<PickerKind, string[]>> = {};
const pickerInflight: Partial<Record<PickerKind, Promise<string[]>>> = {};

async function fetchPicker(kind: PickerKind): Promise<string[]> {
	if (pickerCache[kind]) return pickerCache[kind] ?? [];
	if (pickerInflight[kind]) return pickerInflight[kind] ?? [];
	const p = (async () => {
		const resp = await fetch(`/api/picker/${kind}`);
		if (!resp.ok) throw new Error(`picker/${kind} HTTP ${resp.status}`);
		const json = (await resp.json()) as string[] | { name: string }[];
		const list = Array.isArray(json)
			? json.map((x) => (typeof x === "string" ? x : x.name))
			: [];
		pickerCache[kind] = list;
		delete pickerInflight[kind];
		return list;
	})();
	pickerInflight[kind] = p;
	return p;
}

interface LineScoped {
	stops: string[];
	directions: string[];
}

/** Per-line pick-list cache — keyed by the exact line name. Most users
 * will subscribe to a single line in a session, so caching one line
 * across modal re-opens costs almost nothing. */
const lineScopedCache = new Map<string, LineScoped>();
const lineScopedInflight = new Map<string, Promise<LineScoped>>();

async function fetchLineScoped(line: string): Promise<LineScoped> {
	const cached = lineScopedCache.get(line);
	if (cached) return cached;
	const inflight = lineScopedInflight.get(line);
	if (inflight) return inflight;
	const p = (async () => {
		const resp = await fetch(
			`/api/picker/line-stops?line=${encodeURIComponent(line)}`,
		);
		if (!resp.ok) throw new Error(`picker/line-stops HTTP ${resp.status}`);
		const json = (await resp.json()) as LineScoped;
		const result: LineScoped = {
			stops: Array.isArray(json.stops) ? json.stops : [],
			directions: Array.isArray(json.directions) ? json.directions : [],
		};
		lineScopedCache.set(line, result);
		lineScopedInflight.delete(line);
		return result;
	})();
	lineScopedInflight.set(line, p);
	return p;
}

/** 7 weekday toggles; internal value is the bot's numeric format
 * (`0=Sun..6=Sat`, comma-separated) so we can hand it straight to
 * `buildSubscribeUrl` without a second translation step. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABEL: Record<number, string> = {
	1: "Mo",
	2: "Tu",
	3: "We",
	4: "Th",
	5: "Fr",
	6: "Sa",
	0: "Su",
};

interface TimeRange {
	from: string;
	to: string;
}

export interface SubscribeModalProps {
	lang: Lang;
	/** Pre-filled from the host page (line page, stop page, map popup). */
	initial: {
		line?: string;
		direction?: string;
		stopName?: string;
	};
	/** Host-provided direction picklist — used by the line-detail page
	 * where the directions are a static subset of the line's destinations.
	 * Skips the `/api/picker/directions` fetch. */
	availableDirections?: string[];
	onClose: () => void;
}

export function SubscribeModal({
	lang,
	initial,
	availableDirections,
	onClose,
}: SubscribeModalProps) {
	const [line, setLine] = useState(initial.line ?? "");
	const [direction, setDirection] = useState(initial.direction ?? "");
	const [stopName, setStopName] = useState(initial.stopName ?? "");
	const [ranges, setRanges] = useState<TimeRange[]>([{ from: "", to: "" }]);
	const [weekdays, setWeekdays] = useState<Set<number>>(
		() => new Set(WEEKDAY_ORDER),
	);
	const [linesList, setLinesList] = useState<string[]>(
		() => pickerCache.lines ?? [],
	);
	const [stopsList, setStopsList] = useState<string[]>(
		() => pickerCache.stops ?? [],
	);
	const [directionsList, setDirectionsList] = useState<string[]>(
		() => pickerCache.directions ?? [],
	);
	const [lineScoped, setLineScoped] = useState<LineScoped | null>(() =>
		initial.line ? (lineScopedCache.get(initial.line) ?? null) : null,
	);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [onClose]);

	useEffect(() => {
		let alive = true;
		if (linesList.length === 0)
			fetchPicker("lines")
				.then((l) => alive && setLinesList(l))
				.catch(() => {});
		if (stopsList.length === 0)
			fetchPicker("stops")
				.then((l) => alive && setStopsList(l))
				.catch(() => {});
		if (
			directionsList.length === 0 &&
			(!availableDirections || availableDirections.length === 0)
		)
			fetchPicker("directions")
				.then((l) => alive && setDirectionsList(l))
				.catch(() => {});
		return () => {
			alive = false;
		};
	}, [
		linesList.length,
		stopsList.length,
		directionsList.length,
		availableDirections,
	]);

	// Wait until the full line list is loaded before fetching scoped data —
	// otherwise every keystroke during search would hit the API.
	useEffect(() => {
		if (!line || (linesList.length > 0 && !linesList.includes(line))) {
			setLineScoped(null);
			return;
		}
		let alive = true;
		fetchLineScoped(line)
			.then((scoped) => alive && setLineScoped(scoped))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [line, linesList]);

	useEffect(() => {
		if (!lineScoped) return;
		if (stopName && !lineScoped.stops.includes(stopName)) setStopName("");
		if (direction && !lineScoped.directions.includes(direction))
			setDirection("");
	}, [lineScoped, stopName, direction]);

	const timeRanges = useMemo(
		() =>
			ranges
				.filter((r) => r.from && r.to)
				.map((r) => `${r.from}-${r.to}`)
				.join(","),
		[ranges],
	);

	const weekdayStr = useMemo(() => {
		if (weekdays.size === 7) return ""; // every day → omit
		return WEEKDAY_ORDER.filter((d) => weekdays.has(d)).join(",");
	}, [weekdays]);

	const url = useMemo(
		() =>
			buildSubscribeUrl({
				line: line.trim(),
				direction: direction.trim() || undefined,
				stopName: stopName.trim() || undefined,
				timeRanges: timeRanges || undefined,
				weekdays: weekdayStr || undefined,
			}),
		[line, direction, stopName, timeRanges, weekdayStr],
	);

	const canSubmit = line.trim().length > 0;

	const pill =
		"px-3 py-1.5 text-meta font-bold rounded-full border border-border cursor-pointer transition-colors";
	const pillOn = "bg-accent/10 text-fg border-accent/60";
	const pillOff = "bg-transparent text-muted hover:text-fg";
	const field =
		"w-full bg-surface border border-border rounded px-2 py-1.5 text-body text-fg";
	const label = "text-meta uppercase tracking-wide text-muted font-bold";

	return (
		<div
			className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/50"
			onClick={onClose}
			onKeyDown={(e) => {
				if (e.target === e.currentTarget && e.key === "Enter") onClose();
			}}
		>
			<div
				className="relative w-full max-w-md bg-surface border border-border rounded-sm shadow-xl p-5 space-y-4"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<button
					type="button"
					onClick={onClose}
					aria-label={t(lang, "subscribe.cancel")}
					className="absolute top-3 right-3 text-muted hover:text-fg cursor-pointer"
				>
					✕
				</button>
				<header>
					<h2 className="text-lg font-bold text-fg">
						{t(lang, "subscribe.modal.title")}
					</h2>
					<p className="text-xs text-muted mt-1">
						{t(lang, "subscribe.modal.subtitle")}
					</p>
				</header>

				<div className="space-y-3">
					<div>
						<div className={label}>{t(lang, "subscribe.line")}</div>
						<Combobox
							value={line}
							onChange={setLine}
							options={linesList}
							placeholder="e.g. S6"
							ariaLabel={t(lang, "subscribe.line")}
							strict
						/>
					</div>

					<div>
						<div className={label}>{t(lang, "subscribe.direction")}</div>
						<Combobox
							value={direction}
							onChange={setDirection}
							options={
								availableDirections && availableDirections.length > 0
									? availableDirections
									: lineScoped
										? lineScoped.directions
										: directionsList
							}
							placeholder={t(lang, "subscribe.direction.any")}
							ariaLabel={t(lang, "subscribe.direction")}
							strict
						/>
					</div>

					<div>
						<div className={label}>{t(lang, "subscribe.stop")}</div>
						<Combobox
							value={stopName}
							onChange={setStopName}
							options={lineScoped ? lineScoped.stops : stopsList}
							placeholder={t(lang, "subscribe.stop.any")}
							ariaLabel={t(lang, "subscribe.stop")}
							strict
						/>
					</div>

					<div>
						<div className={label}>{t(lang, "subscribe.hours")}</div>
						<div className="space-y-2">
							{ranges.map((r, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: fixed-position rows
									key={i}
									className="flex items-center gap-2"
								>
									<input
										type="time"
										className={field}
										value={r.from}
										onChange={(e) => {
											const next = [...ranges];
											next[i] = { ...next[i], from: e.target.value };
											setRanges(next);
										}}
									/>
									<span className="text-muted text-xs">→</span>
									<input
										type="time"
										className={field}
										value={r.to}
										onChange={(e) => {
											const next = [...ranges];
											next[i] = { ...next[i], to: e.target.value };
											setRanges(next);
										}}
									/>
									{ranges.length > 1 && (
										<button
											type="button"
											onClick={() =>
												setRanges(ranges.filter((_, j) => j !== i))
											}
											aria-label={t(lang, "subscribe.hours.remove_range")}
											className="text-muted hover:text-fg cursor-pointer text-sm"
										>
											✕
										</button>
									)}
								</div>
							))}
							<button
								type="button"
								onClick={() => setRanges([...ranges, { from: "", to: "" }])}
								className={`${pill} ${pillOff}`}
							>
								+ {t(lang, "subscribe.hours.add_range")}
							</button>
						</div>
					</div>

					<div>
						<div className={label}>{t(lang, "subscribe.weekdays")}</div>
						<div className="flex flex-wrap gap-2">
							{WEEKDAY_ORDER.map((d) => (
								<button
									key={d}
									type="button"
									onClick={() => {
										const next = new Set(weekdays);
										if (next.has(d)) next.delete(d);
										else next.add(d);
										setWeekdays(next);
									}}
									className={`${pill} ${weekdays.has(d) ? pillOn : pillOff}`}
								>
									{WEEKDAY_LABEL[d]}
								</button>
							))}
						</div>
					</div>
				</div>

				<footer className="flex justify-end gap-2 pt-2">
					<button
						type="button"
						onClick={onClose}
						className={`${pill} ${pillOff}`}
					>
						{t(lang, "subscribe.cancel")}
					</button>
					<a
						href={canSubmit ? url : undefined}
						target="_blank"
						rel="noopener noreferrer"
						onClick={(e) => {
							if (!canSubmit) e.preventDefault();
							else onClose();
						}}
						aria-disabled={!canSubmit}
						className={`${pill} ${canSubmit ? "bg-accent text-white border-accent" : "opacity-50 cursor-not-allowed"} no-underline`}
					>
						{t(lang, "subscribe.submit")}
					</a>
				</footer>
			</div>
		</div>
	);
}
