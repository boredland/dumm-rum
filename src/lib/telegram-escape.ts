/**
 * Telegram messages are sent with parse_mode: "HTML", so unescaped user or
 * upstream text breaks delivery (400 Bad Request) and enables markup injection.
 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
