import { SUBJECT_MODES } from "@/src/core";
import { deleteSubject, getSubject, stores, subjectChat } from "@/src/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const subject = getSubject(id);
	if (!subject) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({
		id: subject.id,
		kind: subject.kind,
		title: subject.title,
		source: subject.source,
		modes: SUBJECT_MODES.filter((mode) => subjectChat(subject, mode) !== null),
	});
}

/** Rename the paper or topic. A non-empty string after trim. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
	if (typeof body?.title !== "string" || body.title.trim() === "") {
		return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	}
	const record = stores.subjectStore.renameSubject(id, body.title);
	if (!record) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ title: record.title });
}

/**
 * DELETE /api/subjects/[id]?mode=preserve-graph|delete-nodes — delete a paper
 * or topic with every conversation in it. The mode is required and means
 * what it means for one session (app/api/chats/[id]): keep what the
 * conversations added to the map, or remove it too. 409/503 from a
 * conversation with running work are passed through; they are retryable and
 * leave the subject in place. A paper's shared cache is kept.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const mode = new URL(req.url).searchParams.get("mode");
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		return Response.json({ error: "mode must be preserve-graph or delete-nodes" }, { status: 400 });
	}
	const outcome = await deleteSubject(id, mode);
	if (!outcome.ok) return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
	return Response.json(outcome);
}
