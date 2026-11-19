import { compactionInFlight, createSession, fileLooseChats, graphPicksOf, isTurnRunning, listChats } from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; paperMode?: unknown; graphContext?: unknown };
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	// papersplainer: kind "paper" marks a paper session; the guide agent
	// runs it from turn 1 in the chosen mode (walkthrough unless "chat").
	// Model stamping and the map context live in createSession (shared with
	// a subject's mode conversations).
	const chat = createSession({
		title: typeof body.title === "string" ? body.title : "",
		kind: body.kind === "practice" ? "practice" : body.kind === "paper" ? "paper" : undefined,
		paperMode: body.paperMode === "chat" ? "chat" : "walkthrough",
		picks: graphPicksOf((body.graphContext as { propositions?: unknown } | undefined)?.propositions),
	});
	// papersplainer: a session born outside a subject (the home screen's
	// composer) is filed at once as its own topic, so its page opens with
	// the subject header instead of waiting for the next list read.
	fileLooseChats();
	return Response.json({ id: chat.id, title: chat.title });
}
