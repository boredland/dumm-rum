interface TailEvent {
	scriptName: string;
	outcome: string;
	exceptions: { name: string; message: string; timestamp: number }[];
	logs: { level: string; message: unknown[]; timestamp: number }[];
	eventTimestamp: number;
}

export default {
	async tail(events: TailEvent[], env: { WEBHOOK_URL?: string }) {
		const url = env.WEBHOOK_URL;
		if (!url) return;

		const errors = events.filter(
			(e) => e.outcome === "exception" || e.exceptions.length > 0,
		);
		if (errors.length === 0) return;

		const lines = errors.map((e) => {
			const time = new Date(e.eventTimestamp).toISOString();
			const msgs = e.exceptions
				.map((ex) => `${ex.name}: ${ex.message}`)
				.join("; ");
			return `[${time}] ${e.scriptName}: ${e.outcome} — ${msgs}`;
		});

		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text: `DummRum worker errors:\n${lines.join("\n")}`,
			}),
		});
	},
};
