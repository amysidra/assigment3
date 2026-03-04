import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { notesRouter } from "./modules/notes/router";
import { cors } from "hono/cors";

const app = new Hono()
  .use(cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
  }))
	.route("/notes", notesRouter)

	.get("/", (c) => {
		return c.text("Hello Hono!");
	});

export type AppType = typeof app;

serve(
	{
		fetch: app.fetch,
		port: 8000,
	},
	(info) => {
		console.log(`Server is running on http://localhost:${info.port}`);
	},
);
