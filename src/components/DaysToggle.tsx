import { useMemo, useState } from "react";
import type { Lang } from "../lib/i18n.ts";
import { t } from "../lib/i18n.ts";
import { todayBerlin } from "../lib/utils.ts";
import { FilterGroup } from "./FilterGroup.tsx";

export type DaysFilter = "today" | "all" | "weekdays" | "weekends";

const FILTERS: {
	key: DaysFilter;
	labelKey: "days.today" | "days.all" | "days.weekdays" | "days.weekends";
}[] = [
	{ key: "today", labelKey: "days.today" },
	{ key: "all", labelKey: "days.all" },
	{ key: "weekdays", labelKey: "days.weekdays" },
	{ key: "weekends", labelKey: "days.weekends" },
];

interface DayRow {
	date: string;
}

function matchesFilter<T extends DayRow>(row: T, filter: DaysFilter): boolean {
	if (filter === "all") return true;
	if (filter === "today") return row.date === todayBerlin();
	const dow = new Date(`${row.date}T00:00:00`).getDay(); // 0=Sun..6=Sat
	if (filter === "weekdays") return dow >= 1 && dow <= 5;
	return dow === 0 || dow === 6;
}

export function useDaysFilter<T extends DayRow>(
	days: T[],
	options?: {
		/** Controlled value; if provided, local state is bypassed. */
		value?: DaysFilter;
		/** Controlled setter; called alongside any internal update. */
		onChange?: (f: DaysFilter) => void;
	},
): {
	filtered: T[];
	active: DaysFilter;
	setActive: (f: DaysFilter) => void;
} {
	const [localActive, setLocalActive] = useState<DaysFilter>("all");
	const active = options?.value ?? localActive;
	const setActive = (v: DaysFilter) => {
		setLocalActive(v);
		options?.onChange?.(v);
	};
	const filtered = useMemo(
		() => days.filter((d) => matchesFilter(d, active)),
		[days, active],
	);
	return { filtered, active, setActive };
}

export function DaysToggleBar({
	lang,
	active,
	setActive,
}: {
	lang: Lang;
	active: DaysFilter;
	setActive: (f: DaysFilter) => void;
}) {
	return (
		<FilterGroup
			options={FILTERS.map((f) => ({ key: f.key, label: t(lang, f.labelKey) }))}
			selected={active}
			onToggle={setActive}
		/>
	);
}
