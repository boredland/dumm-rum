/**
 * Shared helpers for mapping reliability scores to the tokenised status
 * colour set. Single source of truth so a threshold tweak (e.g. moving
 * the "amber" band) lands in one file, and so no call site has to know
 * the raw Tailwind palette — they all speak the `danger / warn / ok`
 * vocabulary declared in `src/styles.css`.
 */

/** Border colour that reflects an on-time-rate score on the
 * 0-100 scale. `<80` → danger, `<90` → warn, else → ok. */
export function borderForScore(score: number): string {
	if (score < 80) return "border-danger";
	if (score < 90) return "border-warn";
	return "border-ok";
}

/** Border colour that reflects a cancellation rate (0.0-1.0). Picks
 * tighter thresholds than the score-based variant because a 10 %
 * cancellation rate is already an outlier. */
export function borderForCancRate(rate: number): string {
	if (rate > 0.1) return "border-danger";
	if (rate > 0.05) return "border-warn";
	return "border-ok";
}

/** Text colour that reflects an on-time-rate score. Mirrors the border
 * thresholds so the card's border and its headline read as the same
 * severity. */
export function textForScore(score: number): string {
	if (score < 80) return "text-danger";
	if (score < 90) return "text-warn";
	return "text-ok";
}

/** LED-glow variant of textForScore. Reserved for numeric cells that
 * represent live/anomaly data on a signage surface. */
export function ledForScore(score: number): string {
	if (score < 80) return "led-text-danger";
	if (score < 90) return "led-text-warn";
	return "led-text-ok";
}

/** LED colour for an anomaly-count cell: dimmed when 0, coloured when >0.
 * Use on ledger tables where most rows are quiet and the exception lights
 * up. `tone` selects the semantic colour for the non-zero state. */
export function ledForCount(
	count: number,
	tone: "danger" | "warn" | "info",
): string {
	if (count === 0) return "text-dimmed";
	return `led-text-${tone}`;
}
