import type { ReactNode } from "react";

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

const GLYPH: Record<Status, string> = {
	cancelled: "❌",
	ghost: "👻",
	delayed: "⏳",
	ok: "✅",
};

const TONE: Record<Status, string> = {
	cancelled: "led-text-danger",
	ghost: "led-text-info",
	delayed: "led-text-warn",
	ok: "led-text-ok",
};

const EDGE: Record<Status, string> = {
	cancelled: "border-danger",
	ghost: "border-info",
	delayed: "border-warn",
	ok: "border-border-dim",
};

export function StatusGlyph({
	cancelled,
	ghost,
	delayMin,
	threshold,
}: {
	cancelled: boolean;
	ghost: boolean | number;
	delayMin: number | null;
	threshold?: number;
}) {
	const status = deriveStatus(cancelled, ghost, delayMin, threshold);
	const label =
		status === "delayed" && delayMin !== null
			? `+${delayMin}`
			: GLYPH[status];
	return (
		<span
			className={`inline-flex items-center justify-center w-12 h-6 text-meta font-black tabular-nums ${TONE[status]}`}
		>
			{label}
		</span>
	);
}

export function LedRow({
	time,
	rtTime,
	line,
	direction,
	cancelled,
	ghost,
	delayMin,
	threshold = 8,
}: {
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
		<li
			className={`led-display flex items-center gap-3 border-l-2 ${EDGE[status]} px-3 py-2 text-body font-black tabular-nums`}
		>
			<span className="shrink-0 w-20 text-white">
				{time.slice(0, 5)}
				{rtDelta && (
					<span className={`ml-1 ${TONE[status]}`}>
						→{rtTime.slice(0, 5)}
					</span>
				)}
			</span>
			<span className="shrink-0 w-20 text-meta uppercase tracking-widest text-white/80">
				{line}
			</span>
			<span className="flex-1 min-w-0 truncate text-body text-white/90">
				{direction}
			</span>
			<StatusGlyph
				cancelled={cancelled}
				ghost={ghost}
				delayMin={delayMin}
				threshold={threshold}
			/>
		</li>
	);
}
