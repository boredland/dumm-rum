import type { ReactNode } from "react";

/** The four headline numbers for an entity, set as a row of figures under
 * a shared rule rather than four separate cards. Boxing each number made
 * them look like four unrelated readouts; a single band reads as one
 * summary. */
export function Figures({ children }: { children: ReactNode }) {
	return (
		<dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-5 border-y border-rule py-5">
			{children}
		</dl>
	);
}

export function Figure({
	label,
	value,
	tone,
	note,
}: {
	label: string;
	value: string;
	tone?: string;
	note?: string;
}) {
	return (
		<div className="space-y-0.5">
			<dt className="text-micro uppercase tracking-[0.08em] text-muted">
				{label}
			</dt>
			<dd className={`figures text-figure ${tone ?? ""}`}>{value}</dd>
			{note && <p className="text-micro text-dimmed">{note}</p>}
		</div>
	);
}
