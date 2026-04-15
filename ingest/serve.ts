// Tiny bootstrap: imports the built TanStack Start fetch handler and
// serves it via Bun.serve. Kept outside src/ so it's not typechecked
// against schema (dist/ only exists after `vite build`).

const entry = (await import("./dist/server/server.js")).default as {
	fetch: (req: Request) => Response | Promise<Response>;
};

const port = Number(process.env.PORT ?? 3000);
Bun.serve({ port, fetch: (req) => entry.fetch(req) });
console.log(`ui listening on :${port}`);
