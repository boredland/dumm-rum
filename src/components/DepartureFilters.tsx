import { useMemo, useState } from "react";
import type { Lang } from "../lib/i18n.ts";
import { t } from "../lib/i18n.ts";
import { buildSubscribeUrl } from "../lib/telegram-deeplink.ts";
import { DELAY_THRESHOLD_MIN } from "../lib/utils.ts";
import { Pill } from "./Pill.tsx";

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
	options?: {
		status?: { value: StatusFilter; onChange: (v: StatusFilter) => void };
		hours?: { value: HoursFilter; onChange: (v: HoursFilter) => void };
		dir?: { value: string; onChange: (v: string) => void };
	},
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
	const [localStatus, setLocalStatus] = useState<StatusFilter>("all");
	const [localHours, setLocalHours] = useState<HoursFilter>("all");
	const [localDir, setLocalDir] = useState("all");
	const statusFilter = options?.status?.value ?? localStatus;
	const hoursFilter = options?.hours?.value ?? localHours;
	const dirFilter = options?.dir?.value ?? localDir;
	const setStatusFilter = (v: StatusFilter) => {
		setLocalStatus(v);
		options?.status?.onChange(v);
	};
	const setHoursFilter = (v: HoursFilter) => {
		setLocalHours(v);
		options?.hours?.onChange(v);
	};
	const setDirFilter = (v: string) => {
		setLocalDir(v);
		options?.dir?.onChange(v);
	};

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
					<Pill
						key={key}
						active={statusFilter === key}
						onClick={() => setStatusFilter(key)}
					>
						{label}
					</Pill>
				))}
			</div>
			<div className="flex gap-2">
				{(
					[
						["all", t(lang, "hours.all")],
						["core", t(lang, "hours.core")],
					] as const
				).map(([key, label]) => (
					<Pill
						key={key}
						active={hoursFilter === key}
						onClick={() => setHoursFilter(key)}
					>
						{label}
					</Pill>
				))}
			</div>
			{directions.length > 1 && (
				<select
					value={dirFilter}
					onChange={(e) => setDirFilter(e.target.value)}
					className="bg-surface border border-border rounded-full px-3 py-1.5 text-meta text-muted cursor-pointer"
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
					lines={lines}
					direction={dirFilter}
					hoursFilter={hoursFilter}
				/>
			)}
		</div>
	);
}
function TelegramLinks({
	lines,
	direction,
	hoursFilter,
}: {
	lines: string[];
	direction: string;
	hoursFilter: string;
}) {
	const timeRanges =
		hoursFilter === "core" ? "06:00-09:00,16:00-19:00" : undefined;
	return (
		<div className="flex flex-wrap gap-2 items-center">
			{lines.map((line) => (
				<a
					key={line}
					href={buildSubscribeUrl({ line, direction, timeRanges })}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 px-3 py-1.5 text-meta font-medium rounded-full border border-border text-accent hover:bg-surface-hover transition-colors no-underline"
				>
					<span>📱</span> {line} → Telegram
				</a>
			))}
		</div>
	);
}
