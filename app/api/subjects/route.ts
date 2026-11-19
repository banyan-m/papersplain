import { listSubjectItems, startSubjectChat, subjectFromText } from "@/src/server";

/** The sidebar's list: every paper and topic, newest activity first, with
 *  what its conversations are doing (busy, question or problem waiting).
 *  Sessions that predate subjects are filed on the way (server/subjects.ts). */
export async function GET() {
	return Response.json({ subjects: listSubjectItems() });
}

/**
 * The New box (owner, 2026-11-19). The text is the learner's first message:
 * a link or a PDF path makes a paper, anything else makes a topic. The
 * subject is created together with its walkthrough conversation, which
 * receives that text as its opening message (the client delivers it, as it
 * does for any new session). A paper already listed under the same link or
 * path is reopened instead: its walkthrough is returned if it has one.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { text?: unknown };
	const text = typeof body.text === "string" ? body.text.trim() : "";
	if (!text) return Response.json({ error: "text must be a non-empty string" }, { status: 400 });
	const { subject, existing } = subjectFromText(text);
	const had = existing && subject.chats.walkthrough !== undefined;
	const chat = startSubjectChat(subject.id, "walkthrough", text);
	if (!chat) return Response.json({ error: "Could not start the walkthrough" }, { status: 500 });
	// opening: whether the client should deliver the text as the first message.
	return Response.json({ id: subject.id, kind: subject.kind, title: subject.title, mode: "walkthrough", chatId: chat.id, opening: !had });
}

