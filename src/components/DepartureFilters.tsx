import { useMemo, useState } from "react";
import type { Lang } from "../lib/i18n.ts";
import { t } from "../lib/i18n.ts";
import { DELAY_THRESHOLD_MIN } from "../lib/utils.ts";

const TELEGRAM_BOT = "dummrum_bot";

type StatusFilter = "all" | "issues" | "on_time";
type HoursFilter = "all" | "core";

const CORE_HOURS = [
	[6, 9],
	[16, 19],
] as const;

interface Departure {
	time: string;
	rtTime: string | null;
	date: string;
	direction: string;
	cancelled: boolean;
	ghost: number;
}

function delayMin(
	date: string,
	sched: string,
	rt: string | null,
): number | null {
	if (!rt) return null;
	const planned = new Date(`${date}T${sched}`).getTime();
	const actual = new Date(`${date}T${rt}`).getTime();
	if (!Number.isFinite(planned) || !Number.isFinite(actual)) return null;
	return Math.round((actual - planned) / 60_000);
}

function isIssue(d: Departure): boolean {
	if (d.cancelled || d.ghost) return true;
	const delay = delayMin(d.date, d.time, d.rtTime);
	return delay !== null && delay >= DELAY_THRESHOLD_MIN;
}

function isCoreHour(time: string): boolean {
	const h = Number.parseInt(time.slice(0, 2), 10);
	return CORE_HOURS.some(([from, to]) => h >= from && h < to);
}

export function useDepartureFilters<T extends Departure>(
	departures: T[],
): {
	filtered: T[];
	statusFilter: StatusFilter;
	setStatusFilter: (f: StatusFilter) => void;
	hoursFilter: HoursFilter;
	setHoursFilter: (f: HoursFilter) => void;
	dirFilter: string;
	setDirFilter: (f: string) => void;
	directions: string[];
} {
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [hoursFilter, setHoursFilter] = useState<HoursFilter>("all");
	const [dirFilter, setDirFilter] = useState("all");

	const directions = useMemo(
		() => [...new Set(departures.map((d) => d.direction))].sort(),
		[departures],
	);

	const filtered = useMemo(
		() =>
			departures.filter((d) => {
				if (statusFilter === "issues" && !isIssue(d)) return false;
				if (statusFilter === "on_time" && isIssue(d)) return false;
				if (hoursFilter === "core" && !isCoreHour(d.time)) return false;
				if (dirFilter !== "all" && d.direction !== dirFilter) return false;
				return true;
			}),
		[departures, statusFilter, hoursFilter, dirFilter],
	);

	return {
		filtered,
		statusFilter,
		setStatusFilter,
		hoursFilter,
		setHoursFilter,
		dirFilter,
		setDirFilter,
		directions,
	};
}

export function DepartureFilterBar({
	lang,
	statusFilter,
	setStatusFilter,
	hoursFilter,
	setHoursFilter,
	dirFilter,
	setDirFilter,
	directions,
	lines,
}: {
	lang: Lang;
	statusFilter: StatusFilter;
	setStatusFilter: (f: StatusFilter) => void;
	hoursFilter: HoursFilter;
	setHoursFilter: (f: HoursFilter) => void;
	dirFilter: string;
	setDirFilter: (f: string) => void;
	directions: string[];
	lines?: string[];
}) {
	const pill =
		"px-3 py-1 text-xs font-medium rounded-full border border-border cursor-pointer transition-colors";
	const active = "bg-surface-hover text-fg";
	const inactive = "bg-transparent text-muted hover:text-fg";

	return (
		<div className="flex flex-wrap gap-x-4 gap-y-2 mb-4">
			<div className="flex gap-2">
				{(
					[
						["issues", t(lang, "filter.issues")],
						["all", t(lang, "filter.all")],
						["on_time", t(lang, "filter.on_time")],
					] as const
				).map(([key, label]) => (
					<button
						key={key}
						type="button"
						onClick={() => setStatusFilter(key)}
						className={`${pill} ${statusFilter === key ? active : inactive}`}
					>
						{label}
					</button>
				))}
			</div>
			<div className="flex gap-2">
				{(
					[
						["all", t(lang, "hours.all")],
						["core", t(lang, "hours.core")],
					] as const
				).map(([key, label]) => (
					<button
						key={key}
						type="button"
						onClick={() => setHoursFilter(key)}
						className={`${pill} ${hoursFilter === key ? active : inactive}`}
					>
						{label}
					</button>
				))}
			</div>
			{directions.length > 1 && (
				<select
					value={dirFilter}
					onChange={(e) => setDirFilter(e.target.value)}
					className="bg-surface border border-border rounded-full px-3 py-1 text-xs text-muted cursor-pointer"
				>
					<option value="all">{t(lang, "filter.all_directions")}</option>
					{directions.map((dir) => (
						<option key={dir} value={dir}>
							{dir}
						</option>
					))}
				</select>
			)}
			{dirFilter !== "all" && lines && lines.length > 0 && (
				<TelegramLinks
					lang={lang}
					lines={lines}
					direction={dirFilter}
					hoursFilter={hoursFilter}
				/>
			)}
		</div>
	);
}

function telegramDeepLink(
	line: string,
	direction: string,
	timeRanges?: string,
): string {
	const parts = [line, direction, timeRanges ?? ""].join("|");
	const encoded = btoa(parts).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `https://t.me/${TELEGRAM_BOT}?start=s-${encoded}`;
}

function TelegramLinks({
	lang,
	lines,
	direction,
	hoursFilter,
}: {
	lang: Lang;
	lines: string[];
	direction: string;
	hoursFilter: string;
}) {
	const timeRanges = hoursFilter === "core" ? "06:00-09:00,16:00-19:00" : undefined;
	return (
		<div className="flex flex-wrap gap-2 items-center">
			{lines.map((line) => (
				<a
					key={line}
					href={telegramDeepLink(line, direction, timeRanges)}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border border-border text-accent hover:bg-surface-hover transition-colors no-underline"
				>
					<span>📱</span> {line} → Telegram
				</a>
			))}
		</div>
	);
}
