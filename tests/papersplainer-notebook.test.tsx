/** papersplainer: the subject notebook shared by a subject's three conversations. */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notebook-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
const { isNotebookEmpty, notebookText, NOTEBOOK_LIMITS, screenNotebook, transcriptForNotebook } = await import("../src/core/notebook.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { subjectStore } = await import("../src/store/subjects.ts");
const { updateNotebook } = await import("../src/server/notebook.ts");
const { subjectProgress, subjectPromptAppendix } = await import("../src/server/subjects.ts");
const { SubjectProgressBody } = await import("../components/subject-progress.tsx");

function scripted(...texts: string[]): { engine: PiEngine; calls: () => number; prompts: string[] } {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
	let calls = 0;
	const prompts: string[] = [];
	const streamFn: PiEngine["streamFn"] = ((...args: Parameters<PiEngine["streamFn"]>) => {
		calls++;
		prompts.push(JSON.stringify(args[1]));
		return faux.streamSimple(...args);
	}) as PiEngine["streamFn"];
	return { engine: { model: faux.getModel(), streamFn }, calls: () => calls, prompts };
}
const user = (text: string): LhMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as LhMessage;
const agent = (text: string, call?: { name: string; arguments: unknown }): LhMessage => ({
	role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...(call ? [{ type: "toolCall", id: "c1", ...call }] : [])], timestamp: 1,
}) as unknown as LhMessage;
const result = (toolName: string, text: string, isError = false): LhMessage => ({ role: "toolResult", toolCallId: "c1", toolName, isError, content: [{ type: "text", text }], timestamp: 1 }) as unknown as LhMessage;

describe("the notebook: pure helpers", () => {
	it("screens a reply: trims, de-duplicates, caps, and keeps the newest", () => {
		const many = Array.from({ length: NOTEBOOK_LIMITS.solid + 3 }, (_, i) => `point ${i}`);
		const nb = screenNotebook({ covered: [" Figure 1 ", "figure 1", 7, ""], solid: many, shaky: ["x".repeat(500)], asked: "not a list", next: "  Figure 2  ", extra: true }, { a: 4 }, "now")!;
		assert.deepEqual(nb.covered, ["Figure 1"]);
		assert.equal(nb.solid.length, NOTEBOOK_LIMITS.solid);
		assert.equal(nb.solid.at(-1), `point ${many.length - 1}`);
		assert.equal(nb.shaky[0]!.length, NOTEBOOK_LIMITS.itemChars);
		assert.deepEqual(nb.asked, []);
		assert.equal(nb.next, "Figure 2");
		assert.deepEqual(nb.seen, { a: 4 });
		assert.equal(screenNotebook({ covered: [] }, {}, "now"), null);
		assert.equal(screenNotebook("no json", {}, "now"), null);
		assert.ok(isNotebookEmpty(undefined));
	});

	it("builds the agent's text, and nothing for an empty notebook", () => {
		assert.equal(notebookText(undefined), "");
		const text = notebookText({ updatedAt: "now", covered: ["Abstract"], solid: [], shaky: ["Confused k-mer size with read length"], asked: [], next: "Methods", seen: {} });
		assert.equal(text, "Covered so far:\n- Abstract\nShaky, wrong or not yet shown:\n- Confused k-mer size with read length\nWhere to pick up: Methods");
	});

	it("keeps what he wrote, what the agent said, and the telling calls and results; drops tool chatter", () => {
		const text = transcriptForNotebook([
			user("old message"),
			user("what is a k-mer?"),
			agent("", { name: "paper", arguments: { section: "2" } }),
			result("paper", "Section 2: a very long section text"),
			agent("A k-mer is a substring of length k.", { name: "section", arguments: { title: "k-mers" } }),
			result("problem", "The learner answered: 31. Verdict: wrong."),
			result("quiz", "broken", true),
		], 1);
		assert.ok(!text.includes("old message"));
		assert.match(text, /LEARNER: what is a k-mer\?/);
		assert.match(text, /AGENT: A k-mer is a substring/);
		assert.match(text, /AGENT showed \(section\): \{"title":"k-mers"\}/);
		assert.match(text, /RESULT \(problem\): The learner answered: 31/);
		assert.ok(!text.includes("very long section text") && !text.includes("broken") && !text.includes('"section":"2"'));
	});
});

describe("keeping the notebook", () => {
	it("folds each conversation's new messages in once, shares it with every mode, and shows it in Progress", async () => {
		const subject = subjectStore.createSubject({ kind: "paper", title: "A toy paper" });
		const walk = chatStore.createChat("A toy paper", "paper", "walkthrough", subject.id);
		const practice = chatStore.createChat("A toy paper", "practice", undefined, subject.id);
		subjectStore.setChat(subject.id, "walkthrough", walk.id);
		subjectStore.setChat(subject.id, "practice", practice.id);
		assert.ok(!subjectPromptAppendix(practice.id)?.includes("Notebook"), "no notebook section before anything is known");

		chatStore.saveMessages(walk.id, [user("go"), agent("Here is the abstract.", { name: "section", arguments: { title: "Abstract" } }), user("why squared error?")]);
		const first = scripted(`Here you go:\n${JSON.stringify({ covered: ["Abstract"], solid: [], shaky: [], asked: ["Why squared error rather than absolute error"], next: "Methods, the loss" })}`);
		assert.equal(await updateNotebook(walk.id, first.engine), true);
		assert.equal(first.calls(), 1);
		assert.match(first.prompts[0]!, /why squared error\?/);
		assert.match(first.prompts[0]!, /\(empty\)/);
		assert.deepEqual(subjectStore.getSubject(subject.id)?.notebook?.seen, { [walk.id]: 3 });

		const idle = scripted("{}");
		assert.equal(await updateNotebook(walk.id, idle.engine), false);
		assert.equal(idle.calls(), 0, "nothing new: no model call");

		// The practice conversation is told what the walkthrough established.
		const appendix = subjectPromptAppendix(practice.id) ?? "";
		assert.match(appendix, /## Notebook: what is known about this learner here/);
		assert.match(appendix, /- Why squared error rather than absolute error/);
		assert.match(appendix, /Where to pick up: Methods, the loss/);

		// A practice exchange adds to the same notebook, and sees the old one.
		chatStore.saveMessages(practice.id, [user("start"), result("problem", "The learner answered: it penalises large misses more. Verdict: correct.")]);
		const second = scripted(JSON.stringify({ covered: ["Abstract"], solid: ["Squared error penalises large misses more (answered correctly in practice)"], shaky: [], asked: [], next: "Methods" }));
		assert.equal(await updateNotebook(practice.id, second.engine), true);
		assert.match(second.prompts[0]!, /Covered so far/);
		const notebook = subjectStore.getSubject(subject.id)!.notebook!;
		assert.deepEqual(notebook.seen, { [walk.id]: 3, [practice.id]: 2 });
		assert.equal(notebook.solid.length, 1);

		const progress = subjectProgress(subjectStore.getSubject(subject.id)!);
		assert.deepEqual(progress.understanding?.solid, notebook.solid);
		const html = renderToStaticMarkup(<SubjectProgressBody subject={{ id: subject.id, kind: "paper" }} progress={progress} />);
		assert.match(html, /data-testid="progress-understanding"/);
		assert.match(html, /You have shown you understand/);
		assert.match(html, /Pick up at: <\/span>Methods/);
		assert.ok(!html.includes('data-testid="understanding-shaky"'), "empty lists are not shown");
	});

	it("an unusable reply or a failed call leaves the notebook and its marks alone", async () => {
		const subject = subjectStore.createSubject({ kind: "topic", title: "Hidden Markov models" });
		const chat = chatStore.createChat("HMMs", "paper", "chat", subject.id);
		subjectStore.setChat(subject.id, "chat", chat.id);
		chatStore.saveMessages(chat.id, [user("what is the forward algorithm?")]);
		assert.equal(await updateNotebook(chat.id, scripted("I cannot help with that.").engine), false);
		assert.equal(subjectStore.getSubject(subject.id)?.notebook, undefined);
		const progress = subjectProgress(subjectStore.getSubject(subject.id)!);
		assert.equal(progress.understanding, null);
		assert.match(renderToStaticMarkup(<SubjectProgressBody subject={{ id: subject.id, kind: "topic" }} progress={progress} />), /appears here after your first exchange/);
		// The same messages are offered again next time.
		const retry = scripted(JSON.stringify({ asked: ["The forward algorithm"] }));
		assert.equal(await updateNotebook(chat.id, retry.engine), true);
		assert.equal(retry.calls(), 1);
	});

	it("a conversation outside any subject is ignored", async () => {
		const loose = chatStore.createChat("Loose", "paper", "chat");
		const none = scripted("{}");
		assert.equal(await updateNotebook(loose.id, none.engine), false);
		assert.equal(none.calls(), 0);
	});
});
