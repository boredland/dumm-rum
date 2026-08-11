import type { ReactNode } from "react";
import { type Lang, t } from "../lib/i18n.ts";

export type Status = "cancelled" | "ghost" | "delayed" | "ok";

function deriveStatus(
	cancelled: boolean,
	ghost: boolean | number,
	delayMin: number | null,
	threshold = 8,
): Status {
	if (cancelled) return "cancelled";
	if (ghost) return "ghost";
	if (delayMin !== null && delayMin >= threshold) return "delayed";
	return "ok";
}

const TONE: Record<Status, string> = {
	cancelled: "text-bad",
	ghost: "text-ghost",
	delayed: "text-mixed",
	ok: "text-dimmed",
};

const LABEL_KEY = {
	cancelled: "status.cancelled",
	ghost: "status.ghost",
	delayed: "status.delayed",
	ok: "status.on_time",
} as const;

/** Status as a word, not a pictogram. Emoji were unreadable to screen
 * readers and gave every row equal visual weight; a set verdict lets the
 * exceptions stand out on their own. */
export function StatusMark({
	lang,
	cancelled,
	ghost,
	delayMin,
	threshold,
}: {
	lang: Lang;
	cancelled: boolean;
	ghost: boolean | number;
	delayMin: number | null;
	threshold?: number;
}) {
	const status = deriveStatus(cancelled, ghost, delayMin, threshold);
	// On-time is the expected case, so it carries no label — printing
	// "on time" on most rows gave the exceptions nothing to stand out
	// against. Screen readers still get the word.
	if (status === "ok") {
		return <span className="sr-only">{t(lang, "status.ok")}</span>;
	}
	const label =
		status === "delayed" && delayMin !== null
			? t(lang, "status.delayed_by", { min: delayMin })
			: t(lang, LABEL_KEY[status]);
	return <span className={`text-meta ${TONE[status]}`}>{label}</span>;
}

export function DepartureRow({
	lang,
	time,
	rtTime,
	line,
	direction,
	cancelled,
	ghost,
	delayMin,
	threshold = 8,
}: {
	lang: Lang;
	time: string;
	rtTime: string | null;
	line: ReactNode;
	direction: string;
	cancelled: boolean;
	ghost: boolean | number;
	delayMin: number | null;
	threshold?: number;
}) {
	const status = deriveStatus(cancelled, ghost, delayMin, threshold);
	const rtDelta = rtTime && rtTime !== time;
	return (
		<li className="flex items-baseline gap-4 border-b border-rule-dim py-2">
			<span className="figures shrink-0 w-24 text-body">
				{time.slice(0, 5)}
				{rtDelta && (
					<span className={`ml-1 text-meta ${TONE[status]}`}>
						{rtTime.slice(0, 5)}
					</span>
				)}
			</span>
			<span className="figures shrink-0 w-16 text-meta text-muted truncate">
				{line}
			</span>
			<span className="flex-1 min-w-0 truncate">{direction}</span>
			<StatusMark
				lang={lang}
				cancelled={cancelled}
				ghost={ghost}
				delayMin={delayMin}
				threshold={threshold}
			/>
		</li>
	);
}
