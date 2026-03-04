import { Hono } from "hono";
import { prisma } from "../../utils/prisma";

export const notesRouter = new Hono()

	.get("/", async (c) => {
		const notes = await prisma.notes.findMany();
		return c.json(notes);
	})

	.post("/", async (c) => {
		const { content } = await c.req.json();
		const addedNote = await prisma.notes.create({
			data: {
				content,
			},
		});
		return c.json(addedNote);
	});
