import { type Lang, t } from "../lib/i18n.ts";
import type { DayStats } from "../lib/queries.ts";
import { toneForCancRate, toneForScore } from "../lib/status.ts";
import { onTimeRate } from "../lib/utils.ts";
import { Figure, Figures } from "./Figures.tsx";

/** The four headline figures for a line or an operator.
 *
 * Reduced over the day selection, not every day on record: the figures
 * carry no window of their own, so a reader takes them as describing
 * whatever the toggle below says is selected.
 *
 * A selection can be empty (weekends before the first weekend of
 * collection, "today" before the first poll). onTimeRate answers 100 for
 * zero departures, which would read as a perfect day rather than no data,
 * so the rates render as a dash instead — which is why this cannot use
 * `pct` from utils.ts, whose zero answer is "0.0". */
export function SelectionFigures({
	lang,
	days,
}: {
	lang: Lang;
	days: DayStats[];
}) {
	let total = 0;
	let cancelled = 0;
	let ghost = 0;
	let delayed = 0;
	for (const d of days) {
		total += d.total;
		cancelled += d.cancelled;
		ghost += d.ghost;
		delayed += d.delayed;
	}
	const score = onTimeRate(cancelled, delayed, total);
	const pctOf = (n: number) =>
		total === 0 ? "—" : `${((n / total) * 100).toFixed(1)}%`;

	return (
		<Figures>
			<Figure label={t(lang, "stat.departures")} value={String(total)} />
			<Figure
				label={t(lang, "home.cancelled")}
				value={pctOf(cancelled)}
				tone={toneForCancRate(cancelled / (total || 1))}
			/>
			<Figure
				label={t(lang, "home.ghost")}
				value={pctOf(ghost)}
				tone={ghost > 0 ? "text-ghost" : "text-muted"}
			/>
			<Figure
				label={t(lang, "stat.reliability")}
				value={total === 0 ? "—" : `${score}%`}
				tone={toneForScore(score)}
			/>
		</Figures>
	);
}
