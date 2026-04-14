import createClient from "openapi-fetch";
import type { paths } from "./hafas-types";

const BASE_URLS = ["https://www.rmv.de/hapi", "https://www.rmv.de/hapi/latest"];

let urlIndex = 0;

export function createHafasClient(accessId: string) {
	const baseUrl = BASE_URLS[urlIndex++ % BASE_URLS.length];
	return createClient<paths>({
		baseUrl,
		querySerializer: (params) => {
			const search = new URLSearchParams();
			for (const [key, value] of Object.entries(
				params as Record<string, unknown>,
			)) {
				if (value !== undefined) search.set(key, String(value));
			}
			search.set("accessId", accessId);
			return search.toString();
		},
	});
}
