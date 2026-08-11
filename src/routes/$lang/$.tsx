import { createFileRoute } from "@tanstack/react-router";
import { NotFoundPage } from "../../components/NotFoundPage.tsx";

/** Unknown path under a valid language prefix. Renders the same page as the
 * router's own notFound handler so there's one 404, not two that drift. */
export const Route = createFileRoute("/$lang/$")({
	component: NotFoundPage,
});
