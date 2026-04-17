import { useEffect, useMemo, useState } from "react";
import { type Lang, t } from "../lib/i18n.ts";
import { buildSubscribeUrl } from "../lib/telegram-deeplink.ts";

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
	/** Optional picklist of directions for the <select>. If omitted the
	 * user types in freeform. */
	availableDirections?: string[];
	/** Optional picklist of stops. If omitted we fall back to the
	 * pre-filled stopName (or an "any stop" placeholder). */
	availableStops?: { id: string; name: string }[];
	onClose: () => void;
}

export function SubscribeModal({
	lang,
	initial,
	availableDirections,
	availableStops,
	onClose,
}: SubscribeModalProps) {
	const [line, setLine] = useState(initial.line ?? "");
	const [direction, setDirection] = useState(initial.direction ?? "");
	const [stopName, setStopName] = useState(initial.stopName ?? "");
	const [ranges, setRanges] = useState<TimeRange[]>([{ from: "", to: "" }]);
	const [weekdays, setWeekdays] = useState<Set<number>>(
		() => new Set(WEEKDAY_ORDER),
	);

	// Close on Escape.
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [onClose]);

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
		"px-3 py-1.5 text-xs font-medium rounded-full border border-border cursor-pointer transition-colors";
	const pillOn = "bg-accent/10 text-fg border-accent/60";
	const pillOff = "bg-transparent text-muted hover:text-fg";
	const field =
		"w-full bg-surface border border-border rounded px-2 py-1.5 text-sm text-fg";
	const label = "text-xs uppercase tracking-wide text-muted font-semibold";

	return (
		<div
			className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/50"
			onClick={onClose}
			onKeyDown={(e) => {
				if (e.target === e.currentTarget && e.key === "Enter") onClose();
			}}
		>
			<div
				className="relative w-full max-w-md bg-surface border border-border rounded-lg shadow-xl p-5 space-y-4"
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
						<input
							type="text"
							className={field}
							value={line}
							onChange={(e) => setLine(e.target.value)}
							placeholder="e.g. S6"
						/>
					</div>

					<div>
						<div className={label}>{t(lang, "subscribe.direction")}</div>
						{availableDirections && availableDirections.length > 0 ? (
							<select
								className={field}
								value={direction}
								onChange={(e) => setDirection(e.target.value)}
							>
								<option value="">{t(lang, "subscribe.direction.any")}</option>
								{availableDirections.map((d) => (
									<option key={d} value={d}>
										{d}
									</option>
								))}
							</select>
						) : (
							<input
								type="text"
								className={field}
								value={direction}
								onChange={(e) => setDirection(e.target.value)}
								placeholder={t(lang, "subscribe.direction.any")}
							/>
						)}
					</div>

					<div>
						<div className={label}>{t(lang, "subscribe.stop")}</div>
						{availableStops && availableStops.length > 0 ? (
							<select
								className={field}
								value={stopName}
								onChange={(e) => setStopName(e.target.value)}
							>
								<option value="">{t(lang, "subscribe.stop.any")}</option>
								{availableStops.map((s) => (
									<option key={s.id} value={s.name}>
										{s.name}
									</option>
								))}
							</select>
						) : (
							<input
								type="text"
								className={field}
								value={stopName}
								onChange={(e) => setStopName(e.target.value)}
								placeholder={t(lang, "subscribe.stop.any")}
							/>
						)}
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
