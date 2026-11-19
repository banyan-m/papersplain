/**
 * papersplainer: papers and topics (subjects).
 *
 *   1. pure helpers (paper vs topic, titles, which agent runs a mode)
 *   2. the New box route: a topic, a paper, reopening the same paper
 *   3. a mode gets its conversation on first use, once
 *   4. the paper's cache key travels from a conversation to the subject and
 *      on to later conversations
 *   5. filing sessions that predate subjects
 *   6. the paragraph each agent is told
 *   7. deletion
 *
 * Runs under an isolated LH_DATA_DIR, set before any config-loading import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "papersplainer-subjects-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatShapeFor, modeOfChat, paperSourceOf, paperTitleFromSource } = await import("../src/core/contracts.ts");
const { quoteFilePath } = await import("../src/core/file-paths.ts");
const { GET: listRoute, POST: newRoute } = await import("../app/api/subjects/route.ts");
const { POST: modeRoute } = await import("../app/api/subjects/[id]/chats/route.ts");
const { DELETE: deleteRoute, PUT: renameRoute } = await import("../app/api/subjects/[id]/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { subjectStore } = await import("../src/store/subjects.ts");
const { chatPaperKey, setChatPaper } = await import("../src/agent/subagents/paper-cache-store.ts");
const { fileLooseChats, getSubject, listSubjectItems, subjectPromptAppendix } = await import("../src/server/subjects.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function newSubject(text: string) {
	const res = await newRoute(new Request("http://test/api/subjects", json({ text })));
	assert.equal(res.status, 200);
	return (await res.json()) as { id: string; kind: string; title: string; chatId: string; opening: boolean };
}

async function startMode(id: string, mode: string, title = "first message") {
	const res = await modeRoute(new Request(`http://test/api/subjects/${id}/chats`, json({ mode, title })), idParams(id));
	return { status: res.status, body: (await res.json()) as { id?: string } };
}

describe("pure helpers", () => {
	it("a link or a PDF path is a paper; anything else is a topic", () => {
		assert.equal(paperSourceOf("https://arxiv.org/abs/2401.01234"), "https://arxiv.org/abs/2401.01234");
		assert.equal(paperSourceOf("  https://www.biorxiv.org/content/10.1101/x.full.pdf "), "https://www.biorxiv.org/content/10.1101/x.full.pdf");
		assert.equal(paperSourceOf("arxiv:2401.01234"), "arxiv:2401.01234");
		assert.equal(paperSourceOf("/home/m/papers/af3.pdf"), "/home/m/papers/af3.pdf");
		assert.equal(paperSourceOf("C:\\Users\\m\\af3.PDF"), "C:\\Users\\m\\af3.PDF");
		assert.equal(paperSourceOf(quoteFilePath("/home/m/my papers/af 3.pdf")), "/home/m/my papers/af 3.pdf", "the path chip's quoting is unwrapped");
		assert.equal(paperSourceOf("hidden Markov models"), null);
		assert.equal(paperSourceOf("what is in report.pdf"), null, "a sentence that mentions a file is a topic");
		assert.equal(paperSourceOf(`${quoteFilePath("/home/m/notes.txt")}`), null, "a non-PDF path is not a paper");
		assert.equal(paperSourceOf("explain https://arxiv.org/abs/2401.01234 to me"), null);
		assert.equal(paperSourceOf(""), null);
	});

	it("a paper gets a readable first title", () => {
		assert.equal(paperTitleFromSource("https://arxiv.org/abs/2401.01234v2"), "arXiv 2401.01234v2");
		assert.equal(paperTitleFromSource("https://arxiv.org/pdf/2401.01234.pdf"), "arXiv 2401.01234");
		assert.equal(paperTitleFromSource("/home/m/papers/alphafold_3.pdf"), "alphafold 3");
		assert.equal(paperTitleFromSource("C:\\Users\\m\\scVI.pdf"), "scVI");
	});

	it("each mode runs the agent decided for it", () => {
		assert.deepEqual(chatShapeFor("paper", "walkthrough"), { kind: "paper", paperMode: "walkthrough" });
		assert.deepEqual(chatShapeFor("paper", "chat"), { kind: "paper", paperMode: "chat" });
		assert.deepEqual(chatShapeFor("topic", "walkthrough"), { kind: "teach" }, "a topic walkthrough is the teaching session");
		assert.deepEqual(chatShapeFor("topic", "chat"), { kind: "paper", paperMode: "chat" }, "topic chat is the guide, told there is no paper");
		assert.deepEqual(chatShapeFor("paper", "practice"), { kind: "practice" });
		for (const kind of ["paper", "topic"] as const) {
			for (const mode of ["walkthrough", "chat", "practice"] as const) assert.equal(modeOfChat(chatShapeFor(kind, mode)), mode);
		}
	});
});

describe("the New box", () => {
	it("anything that is not a paper becomes a topic with a teaching walkthrough", async () => {
		const made = await newSubject("teach me hidden Markov models");
		assert.equal(made.kind, "topic");
		assert.equal(made.opening, true);
		const chat = chatStore.getChat(made.chatId)!;
		assert.equal(chat.kind, undefined, "teach is the absent kind");
		assert.equal(chat.subjectId, made.id);
		assert.equal(getSubject(made.id)!.chats.walkthrough, made.chatId);
	});

	it("a link becomes a paper with a guide walkthrough; the same link reopens it", async () => {
		const made = await newSubject("https://arxiv.org/abs/2401.01234");
		assert.equal(made.kind, "paper");
		assert.equal(made.title, "arXiv 2401.01234");
		const chat = chatStore.getChat(made.chatId)!;
		assert.equal(chat.kind, "paper");
		assert.equal(chat.paperMode, "walkthrough");
		const again = await newSubject("https://arxiv.org/abs/2401.01234");
		assert.equal(again.id, made.id, "no duplicate paper");
		assert.equal(again.chatId, made.chatId, "the existing walkthrough is returned");
		assert.equal(again.opening, false, "the text is not sent a second time");
	});

	it("empty text is refused", async () => {
		const res = await newRoute(new Request("http://test/api/subjects", json({ text: "   " })));
		assert.equal(res.status, 400);
	});
});

describe("one conversation per mode", () => {
	it("a mode gets its conversation on first use and keeps it", async () => {
		const made = await newSubject("https://example.org/modes.pdf");
		const chat = await startMode(made.id, "chat", "what is the loss?");
		assert.equal(chat.status, 200);
		const record = chatStore.getChat(chat.body.id!)!;
		assert.equal(record.kind, "paper");
		assert.equal(record.paperMode, "chat");
		assert.equal(record.subjectId, made.id);
		const second = await startMode(made.id, "chat", "another first message");
		assert.equal(second.body.id, chat.body.id, "idempotent per mode");
		const practice = await startMode(made.id, "practice");
		assert.equal(chatStore.getChat(practice.body.id!)!.kind, "practice");
		assert.deepEqual(Object.keys(getSubject(made.id)!.chats).sort(), ["chat", "practice", "walkthrough"]);
	});

	it("unknown mode and unknown subject are refused", async () => {
		const made = await newSubject("a topic for refusal");
		assert.equal((await startMode(made.id, "quiz")).status, 400);
		assert.equal((await startMode("subj_missing", "chat")).status, 404);
	});
});

describe("a paper's cache key", () => {
	it("is copied from the conversation that read the PDF, then given to later conversations", async () => {
		const made = await newSubject("https://example.org/cache.pdf");
		assert.equal(getSubject(made.id)!.paperKey, undefined);
		setChatPaper(made.chatId, "0123456789abcdef"); // what the pdf job records on first read
		assert.equal(getSubject(made.id)!.paperKey, "0123456789abcdef");
		const chat = await startMode(made.id, "chat");
		assert.equal(chatPaperKey(chat.body.id!), "0123456789abcdef", "figures and toy data are there from the first turn");
	});
});

describe("filing sessions that predate subjects", () => {
	it("groups paper sessions by PDF, shelves the older of two in one mode, and makes topics of the rest", async () => {
		const older = chatStore.createChat("`/home/m/af3.pdf`", "paper", "walkthrough");
		setChatPaper(older.id, "aaaaaaaaaaaaaaaa");
		await new Promise((r) => setTimeout(r, 5));
		const chatMode = chatStore.createChat("`/home/m/af3.pdf`", "paper", "chat");
		setChatPaper(chatMode.id, "aaaaaaaaaaaaaaaa");
		await new Promise((r) => setTimeout(r, 5));
		const newer = chatStore.createChat("`/home/m/af3.pdf`", "paper", "walkthrough");
		setChatPaper(newer.id, "aaaaaaaaaaaaaaaa");
		const teach = chatStore.createChat("teach me the chain rule");
		const practice = chatStore.createChat("drill me on eigenvalues", "practice");

		fileLooseChats();

		const paperId = chatStore.getChat(newer.id)!.subjectId!;
		const paper = getSubject(paperId)!;
		assert.equal(paper.kind, "paper");
		assert.equal(paper.title, "af3");
		assert.equal(paper.paperKey, "aaaaaaaaaaaaaaaa");
		assert.equal(chatStore.getChat(older.id)!.subjectId, paperId, "same PDF, same paper");
		assert.equal(chatStore.getChat(chatMode.id)!.subjectId, paperId);
		assert.equal(paper.chats.walkthrough, newer.id, "the newest walkthrough is shown");
		assert.equal(paper.chats.chat, chatMode.id);
		assert.deepEqual(paper.shelved, [older.id], "the older one is kept, not shown");
		assert.ok(chatStore.getChat(older.id), "nothing is deleted");

		const topic = getSubject(chatStore.getChat(teach.id)!.subjectId!)!;
		assert.equal(topic.kind, "topic");
		assert.equal(topic.title, "teach me the chain rule");
		assert.equal(topic.chats.walkthrough, teach.id);
		const drilled = getSubject(chatStore.getChat(practice.id)!.subjectId!)!;
		assert.equal(drilled.chats.practice, practice.id);
		assert.notEqual(drilled.id, topic.id, "each loose session is its own topic");

		const before = subjectStore.listSubjects().length;
		fileLooseChats();
		assert.equal(subjectStore.listSubjects().length, before, "idempotent");
	});

	it("the list files loose sessions on the way and reports each subject's modes", async () => {
		const loose = chatStore.createChat("a late loose session");
		const res = await listRoute();
		const { subjects } = (await res.json()) as { subjects: { id: string; title: string; modes: string[]; lastMode: string; kind: string }[] };
		const row = subjects.find((s) => s.title === "a late loose session")!;
		assert.ok(row, "filed and listed");
		assert.deepEqual(row.modes, ["walkthrough"]);
		assert.equal(chatStore.getChat(loose.id)!.subjectId, row.id);
		assert.deepEqual(listSubjectItems().map((s) => s.id), subjects.map((s) => s.id));
	});
});

describe("what each agent is told", () => {
	it("a paper's conversations are told the paper; practice is told to pose from it", async () => {
		const made = await newSubject("https://example.org/told.pdf");
		const walkthrough = subjectPromptAppendix(made.chatId)!;
		assert.match(walkthrough, /https:\/\/example\.org\/told\.pdf/);
		assert.match(walkthrough, /read it before answering/);
		const practice = await startMode(made.id, "practice");
		assert.match(subjectPromptAppendix(practice.body.id!)!, /Pose problems on this paper/);
	});

	it("a topic's walkthrough needs nothing; its chat is told there is no paper", async () => {
		const made = await newSubject("teach me phylogenetic likelihood");
		assert.equal(subjectPromptAppendix(made.chatId), undefined);
		const chat = await startMode(made.id, "chat");
		const told = subjectPromptAppendix(chat.body.id!)!;
		assert.match(told, /teach me phylogenetic likelihood/);
		assert.match(told, /There is no paper to read here/);
		assert.match(told, /never quiz or grade/);
	});

	it("a session that is not filed gets nothing", () => {
		const loose = chatStore.createChat("unfiled");
		assert.equal(subjectPromptAppendix(loose.id), undefined);
		assert.equal(subjectPromptAppendix("chat_missing"), undefined);
	});
});

describe("rename and delete", () => {
	it("renames the subject", async () => {
		const made = await newSubject("https://example.org/rename.pdf");
		const res = await renameRoute(new Request("http://test", { method: "PUT", body: JSON.stringify({ title: "  AlphaFold 3  " }) }), idParams(made.id));
		assert.equal(res.status, 200);
		assert.equal(getSubject(made.id)!.title, "AlphaFold 3");
		const bad = await renameRoute(new Request("http://test", { method: "PUT", body: JSON.stringify({ title: " " }) }), idParams(made.id));
		assert.equal(bad.status, 400);
	});

	it("deleting a subject deletes its conversations, shown and shelved; the mode is required", async () => {
		const made = await newSubject("a topic to delete");
		const chat = await startMode(made.id, "chat");
		const shelved = chatStore.createChat("an older walkthrough");
		chatStore.setSubject(shelved.id, made.id);
		subjectStore.shelveChat(made.id, shelved.id);

		const noMode = await deleteRoute(new Request(`http://test/api/subjects/${made.id}`, { method: "DELETE" }), idParams(made.id));
		assert.equal(noMode.status, 400);
		assert.ok(getSubject(made.id));

		const res = await deleteRoute(new Request(`http://test/api/subjects/${made.id}?mode=preserve-graph`, { method: "DELETE" }), idParams(made.id));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, chatsRemoved: 3 });
		assert.equal(getSubject(made.id), null);
		for (const id of [made.chatId, chat.body.id!, shelved.id]) assert.equal(chatStore.getChat(id), null);

		const gone = await deleteRoute(new Request("http://test/api/subjects/subj_missing?mode=preserve-graph", { method: "DELETE" }), idParams("subj_missing"));
		assert.equal(gone.status, 404);
	});
});
