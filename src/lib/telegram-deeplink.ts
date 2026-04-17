/**
 * Shared encoder for `https://t.me/<bot>?start=s-<base64url>` deep-links
 * that the bot decodes at `/start s-…` (see `src/lib/telegram.ts`, the
 * branch on line ~130).
 *
 * Payload is `line|direction|stopName|timeRanges|weekdays` — five
 * pipe-delimited fields, trailing empties omitted. The bot splits on
 * `|` and threads the values back into a `/subscribe …` command the
 * user taps to confirm, so the schema has to stay stable on both
 * ends; the decoder ignores missing trailing fields.
 */

/** Hardcoded on the server side too; single source kept here. */
export const TELEGRAM_BOT = "dummrum_bot";

export interface SubscribePayload {
	line: string;
	direction?: string;
	/** Free-text stop name matched by the bot's `@<name>` syntax against
	 * `journey_runs.origin_name`. Empty/omitted = any stop. */
	stopName?: string;
	/** Comma-separated list of `HH:MM-HH:MM` ranges. Empty/omitted = all day. */
	timeRanges?: string;
	/** Comma-separated day numbers (0=Sun..6=Sat) as stored, or a
	 * human-readable `Mo-Fr` / `Mo,Di,Mi` string — the bot's
	 * `parseWeekdays()` accepts both. Empty/omitted = every day. */
	weekdays?: string;
}

function base64urlEncode(s: string): string {
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildSubscribeUrl(payload: SubscribePayload): string {
	// Trailing empty fields are dropped so the URL stays short when only
	// `line` is set. The bot's split("|") handles the shortened form.
	const fields = [
		payload.line,
		payload.direction ?? "",
		payload.stopName ?? "",
		payload.timeRanges ?? "",
		payload.weekdays ?? "",
	];
	while (fields.length > 1 && fields[fields.length - 1] === "") fields.pop();
	const encoded = base64urlEncode(fields.join("|"));
	return `https://t.me/${TELEGRAM_BOT}?start=s-${encoded}`;
}
