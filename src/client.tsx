import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

// Registered here rather than from an inline <script> in the document, so
// the app ships no dangerouslySetInnerHTML and needs no script-src hash.
if ("serviceWorker" in navigator) {
	navigator.serviceWorker
		.register("/sw.js")
		.catch((e) => console.warn("sw registration failed:", e));
}

startTransition(() => {
	hydrateRoot(
		document,
		<StrictMode>
			<StartClient />
		</StrictMode>,
	);
});
