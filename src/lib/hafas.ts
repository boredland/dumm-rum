import createClient from "openapi-fetch";
import type { paths } from "./hafas-types";

export function createHafasClient(accessId: string) {
	return createClient<paths>({
		baseUrl: "https://www.rmv.de/hapi",
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
