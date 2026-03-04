import { createFileRoute, useRouter } from "@tanstack/react-router";
import { api } from "#/utils/api";
import { useState } from "react";
import { Button } from "@skypi/ui";

export const Route = createFileRoute("/")({
	component: App,
	loader: async () => {
		const res = await api.notes.$get();
		const notes = await res.json();
		return notes;
	},
});

function App() {
  const router = useRouter();
	const notes = Route.useLoaderData();
  const [content, setContent] = useState("");

  async function handleCreateNote() {
    const res = await api.notes.$post({
      json: {
        content,
      }
    })
    const newNote = await res.json();
    console.log("New note created:", newNote);
    router.invalidate();
  }

	return (
		<div className="p-4">
      <form>
      <textarea onChange={(e) => setContent(e.target.value)}></textarea>
      <Button onClick={handleCreateNote}>save</Button>
    </form>
			<p className="mb-4 text-lg font-bold">Notes:</p>
			{notes.map((note) => (
				<div key={note.id} className="mb-2 rounded bg-gray-100 p-2">
					{note.content}
				</div>
			))}
		</div>
	);
}
