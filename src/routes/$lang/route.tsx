import {
	createFileRoute,
	notFound,
	Outlet,
	useLocation,
} from "@tanstack/react-router";
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

/** Station routes get the platform-yellow hazard stripe (you're at a
 * platform). Line and operator routes get a rail-blue stripe (moving
 * service, not a place). Home and map get yellow by default. */
function stripeClassFor(pathname: string): string {
	if (pathname.includes("/line/") || pathname.includes("/operator/")) {
		return "h-1.5 bg-rail-blue";
	}
	return "platform-yellow-line";
}

function LangLayout() {
	const pathname = useLocation({ select: (s) => s.pathname });
	return (
		<>
			<div className={`${stripeClassFor(pathname)} sticky top-0 z-50`} />
			<Outlet />
		</>
	);
}
