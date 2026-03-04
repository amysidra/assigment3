import { Button } from "@skypi/ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/demo/")({
	component: RouteComponent,
});

function RouteComponent() {
	return (
		<div>
			<Button>Hello World</Button>
		</div>
	);
}
