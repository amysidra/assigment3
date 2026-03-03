import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@skypi/ui";

export const Route = createFileRoute("/demo/")({
  component: RouteComponent,
});

function RouteComponent() {
  return <div><Button>Hello World</Button></div>;
}
