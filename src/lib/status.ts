/**
 * Maps reliability numbers to the report's verdict colours. Single source
 * of truth so a threshold tweak lands in one file, and so no call site has
 * to know the palette — they all speak the `bad / mixed / good` vocabulary
 * declared in `src/styles.css`.
 *
 * Colour is annotation here, never decoration: a figure only takes a tone
 * when the tone is the point of printing it.
 */

/** Verdict tone for an on-time rate on the 0-100 scale.
 * `<80` → bad, `<90` → mixed, else → good. */
export function toneForScore(score: number): string {
	if (score < 80) return "text-bad";
	if (score < 90) return "text-mixed";
	return "text-good";
}

/** Verdict tone for a cancellation rate (0.0-1.0). Tighter thresholds than
 * the score-based variant because a 10 % cancellation rate is already an
 * outlier. */
export function toneForCancRate(rate: number): string {
	if (rate > 0.1) return "text-bad";
	if (rate > 0.05) return "text-mixed";
	return "text-muted";
}

/** Tone for an anomaly count: quiet at zero, coloured above it. Keeps
 * ledger tables calm so the exceptional rows are the ones that catch the
 * eye. */
export function toneForCount(
	count: number,
	tone: "bad" | "mixed" | "ghost",
): string {
	if (count === 0) return "text-dimmed";
	return `text-${tone}`;
}
