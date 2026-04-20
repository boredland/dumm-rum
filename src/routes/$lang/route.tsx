import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { type Lang, languages } from "../../lib/i18n.ts";

export const Route = createFileRoute("/$lang")({
	beforeLoad: ({ params }) => {
		if (!languages.includes(params.lang as Lang)) {
			throw notFound();
		}
		return { lang: params.lang as Lang };
	},
	component: LangLayout,
});

function LangLayout() {
	return <Outlet />;
}
