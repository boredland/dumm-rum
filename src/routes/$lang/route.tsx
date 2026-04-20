import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { Dienststand } from "../../components/Dienststand.tsx";
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
	const { lang } = Route.useParams();
	return (
		<>
			<div className="platform-yellow-line sticky top-0 z-50" />
			<div className="sticky top-[6px] z-40">
				<Dienststand lang={lang as Lang} />
			</div>
			<Outlet />
		</>
	);
}
