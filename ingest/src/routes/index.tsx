import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	// Default lang redirect. Later: replace with Accept-Language detection
	// via a server fn that reads getHeaders() and picks de or en.
	beforeLoad: () => {
		throw redirect({ to: "/$lang", params: { lang: "de" } });
	},
});
