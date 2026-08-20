import type { ReactNode } from "react";
import { type Lang, t } from "../lib/i18n.ts";
import type { DayStats } from "../lib/queries.ts";
import { toneForCount, toneForScore } from "../lib/status.ts";
import { onTimeRate } from "../lib/utils.ts";
import { type DaysFilter, DaysToggleBar } from "./DaysToggle.tsx";
import { EmptyState } from "./EmptyState.tsx";

/** The day-by-day ledger every entity page ends on: one row per day, the
 * four counts, the verdict, and a link onward to that day.
 *
 * The station, line and operator pages print the same table from the same
 * DayStats, so it is one component rather than three copies — three
 * spellings of one table is how a column ends up toned differently on the
 * operator page than on the line page.
 *
 * Only the onward link differs between them, so that is what the caller
 * passes: `dayLink` gets a date and returns the cell's `Link`. Handing the
 * component a route name and params instead would mean typing the union of
 * three routes' params for no gain — the caller already knows its own
 * route. */
export function DailyBreakdown({
	lang,
	days,
	active,
	setActive,
	dayLink,
}: {
	lang: Lang;
	days: DayStats[];
	active: DaysFilter;
	setActive: (f: DaysFilter) => void;
	dayLink: (date: string) => ReactNode;
}) {
	return (
		<section className="space-y-3">
			<h2 className="eyebrow text-ink border-b border-ink pb-2">
				{t(lang, "section.daily_breakdown")}
			</h2>
			<DaysToggleBar lang={lang} active={active} setActive={setActive} />
			{days.length === 0 ? (
				<EmptyState title={t(lang, "table.no_data")} />
			) : (
				<div className="overflow-x-auto">
					<table className="report-table">
						<thead>
							<tr>
								<th>{t(lang, "table.date")}</th>
								<th className="num">{t(lang, "table.th.total")}</th>
								<th className="num">{t(lang, "table.th.cancelled")}</th>
								<th className="num">{t(lang, "table.th.ghost")}</th>
								<th className="num">{t(lang, "table.th.delayed")}</th>
								<th className="num">{t(lang, "table.otp")}</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{days.map((d) => {
								const dayScore = onTimeRate(d.cancelled, d.delayed, d.total);
								return (
									<tr key={d.date}>
										<td className="whitespace-nowrap">
											{new Date(`${d.date}T00:00:00`).toLocaleDateString(lang, {
												weekday: "short",
												day: "2-digit",
												month: "2-digit",
											})}
										</td>
										<td className="num text-muted">{d.total}</td>
										<td className={`num ${toneForCount(d.cancelled, "bad")}`}>
											{d.cancelled || "—"}
										</td>
										<td className={`num ${toneForCount(d.ghost, "ghost")}`}>
											{d.ghost || "—"}
										</td>
										<td className={`num ${toneForCount(d.delayed, "mixed")}`}>
											{d.delayed || "—"}
										</td>
										<td className={`num ${toneForScore(dayScore)}`}>
											{dayScore}%
										</td>
										<td className="num">{dayLink(d.date)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
