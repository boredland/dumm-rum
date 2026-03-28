import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (_context, next) => {
	const response = await next();
	const contentType = response.headers.get("content-type") ?? "";

	if (
		contentType.includes("text/html") ||
		contentType.includes("application/json")
	) {
		response.headers.set(
			"Cache-Control",
			"public, s-maxage=300, stale-while-revalidate=300",
		);
	}

	return response;
});
