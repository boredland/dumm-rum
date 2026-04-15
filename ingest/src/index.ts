import { startIngest } from "./lib/workers.ts";

async function main(): Promise<void> {
	const { shutdown } = await startIngest();

	const signal = async (sig: string): Promise<void> => {
		console.log(`${sig} received, shutting down`);
		await shutdown();
		process.exit(0);
	};
	process.on("SIGINT", () => signal("SIGINT"));
	process.on("SIGTERM", () => signal("SIGTERM"));
}

main().catch((e) => {
	console.error("fatal:", e);
	process.exit(1);
});
