import { isSubjectMode } from "@/src/core";
import { startSubjectChat } from "@/src/server";

/**
 * Give a mode its conversation — called with the first message sent in that
 * mode (no conversation exists until then, like any new session). The title
 * is that first message. Idempotent per mode: if the mode already has a
 * conversation, it is returned.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => ({}))) as { mode?: unknown; title?: unknown };
	if (!isSubjectMode(body.mode)) return Response.json({ error: "mode must be walkthrough, chat or practice" }, { status: 400 });
	const title = typeof body.title === "string" ? body.title : "";
	const chat = startSubjectChat(id, body.mode, title);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ id: chat.id, title: chat.title });
}
