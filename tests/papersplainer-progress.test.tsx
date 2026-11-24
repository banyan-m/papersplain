/**
 * papersplainer: the Progress view — derived only from what the
 * conversations recorded (no model call, no judgement of understanding).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "papersplainer-progress-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { outlineOf, outlineSteps, planSteps, practiceResults, stepPosition } = await import("../src/core/subject-progress.ts");
const { outlineTool } = await import("../src/agent/tools/outline.ts");
const { guideModeInstructions } = await import("../src/agent/teacher-agent.ts");
const { SubjectProgressBody } = await import("../components/subject-progress.tsx");
const { OutlineCard } = await import("../components/artifacts/outline-card.tsx");
const { subjectMeta } = await import("../components/sidebar.tsx");
const { chatStore } = await import("../src/store/chats.ts");
const { subjectStore } = await import("../src/store/subjects.ts");
const { listSubjectItems, subjectProgress, getSubject } = await import("../src/server/subjects.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type SubjectProgress = import("../src/core/subject-progress.ts").SubjectProgress;

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

let n = 0;
const call = (name: string, args: Record<string, unknown>, id = `call_${++n}`) =>
	({ id: `m_${++n}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }) as unknown as LhMessage;
const result = (toolName: string, toolCallId: string, details: unknown = null, isError = false) =>
	({ id: `m_${++n}`, role: "toolResult", toolCallId, toolName, isError, details, content: [{ type: "text", text: "ok" }] }) as unknown as LhMessage;
const outlineTurn = (sections: string[], current: number, isError = false): LhMessage[] => {
	const id = `call_${++n}`;
	return [call("outline", { sections, current }, id), result("outline", id, isError ? null : { sections, current }, isError)];
};
const SECTIONS = ["The problem", "The diffusion module", "Training", "Results"];

describe("the outline tool", () => {
	const run = (input: unknown) => outlineTool.execute("call_x", input as never, undefined) as Promise<{ content: { text: string }[]; details: unknown; isError?: boolean }>;

	it("records the sections and the current one", async () => {
		const out = await run({ sections: SECTIONS, current: 2 });
		assert.deepEqual(out.details, { sections: SECTIONS, current: 2 });
		assert.match(out.content[0]!.text, /section 2 of 4, "The diffusion module"/);
	});

	it("refuses a position past the end", async () => {
		await assert.rejects(() => run({ sections: SECTIONS, current: 5 }), /only 4 sections/);
	});

	it("the walkthrough is told to keep it; free chat is not", () => {
		assert.match(guideModeInstructions("walkthrough"), /call `outline` with the sections/);
		assert.ok(!guideModeInstructions("chat").includes("outline"));
	});
});

describe("a paper walkthrough's sections", () => {
	it("come from the most recent clean outline call", () => {
		const messages = [...outlineTurn(SECTIONS, 1), ...outlineTurn(SECTIONS, 3)];
		assert.deepEqual(outlineOf(messages), { sections: SECTIONS, current: 3 });
		assert.deepEqual(outlineSteps(outlineOf(messages)!).map((s) => s.state), ["done", "done", "current", "upcoming"]);
		assert.deepEqual(stepPosition(outlineSteps(outlineOf(messages)!)), { current: 3, total: 4 });
	});

	it("an errored call records nothing; no call means no outline", () => {
		assert.deepEqual(outlineOf([...outlineTurn(SECTIONS, 1), ...outlineTurn(SECTIONS, 9, true)]), { sections: SECTIONS, current: 1 });
		assert.equal(outlineOf([]), null);
		assert.equal(stepPosition(null), null);
	});
});

describe("a topic walkthrough's plan", () => {
	it("steps follow the plan's nodes; position comes from tagged quiz calls", () => {
		const tree = { version: 1, edges: [], nodes: [{ id: "a", title: "States and emissions", summary: "What an HMM is." }, { id: "b", title: "Forward algorithm" }, { id: "c", title: "Viterbi" }] };
		const messages = [call("quiz", { nodeId: "a" }), call("quiz", { nodeId: "b" })];
		const steps = planSteps(tree, messages);
		assert.deepEqual(steps.map((s) => s.state), ["done", "current", "upcoming"]);
		assert.equal(steps[0]!.summary, "What an HMM is.");
		assert.deepEqual(planSteps(tree, []).map((s) => s.state), ["upcoming", "upcoming", "upcoming"]);
		assert.equal(stepPosition(planSteps(tree, [])), null, "nothing started: no position");
	});
});

describe("practice results", () => {
	it("counts clean poses and outcomes, newest first, and knows a problem is open", () => {
		const messages: LhMessage[] = [];
		const pose = (statement: string) => { const id = `call_${++n}`; messages.push(call("problem", { statement }, id), result("problem", id)); };
		const conclude = (outcome: string) => { const id = `call_${++n}`; messages.push(call("conclude", { outcome }, id), result("conclude", id)); };
		pose("Why does AF3 denoise coordinates?\nMore detail."); conclude("solved");
		pose("Derive the loss."); conclude("solvedWithHints");
		pose("What would break without recycling?"); conclude("surrendered");
		pose("An open one");
		const failed = `call_${++n}`;
		messages.push(call("problem", { statement: "refused pose" }, failed), result("problem", failed, null, true));
		const r = practiceResults(messages);
		assert.equal(r.posed, 4, "the refused pose does not count");
		assert.deepEqual({ ...r.outcomes }, { solved: 1, solvedWithHints: 1, movedOn: 0, surrendered: 1, dismissed: 0 });
		assert.equal(r.active, true);
		assert.deepEqual(r.recent.map((p) => [p.statement, p.outcome]), [
			["An open one", null],
			["What would break without recycling?", "surrendered"],
			["Derive the loss.", "solvedWithHints"],
			["Why does AF3 denoise coordinates?", "solved"],
		]);
	});

	it("an empty practice conversation has nothing", () => {
		const r = practiceResults([]);
		assert.equal(r.posed, 0);
		assert.equal(r.active, false);
	});
});

describe("the subject's progress, end to end", () => {
	it("reads the walkthrough and practice conversations and reports the row's position", () => {
		const subject = subjectStore.createSubject({ kind: "paper", title: "AlphaFold 3", source: "https://example.org/af3.pdf" });
		const walkthrough = chatStore.createChat("af3", "paper", "walkthrough", subject.id);
		subjectStore.setChat(subject.id, "walkthrough", walkthrough.id);
		assert.deepEqual(subjectProgress(getSubject(subject.id)!), { steps: null, practice: null, concepts: [], understanding: null });
		chatStore.saveMessages(walkthrough.id, outlineTurn(SECTIONS, 2));
		const progress = subjectProgress(getSubject(subject.id)!);
		assert.deepEqual(progress.steps!.map((s) => s.state), ["done", "current", "upcoming", "upcoming"]);
		const item = listSubjectItems().find((s) => s.id === subject.id)!;
		assert.deepEqual(item.position, { current: 2, total: 4 });
		assert.match(subjectMeta(item), /^Section 2 of 4 · /);
	});
});

describe("the Progress view", () => {
	const view = { id: "subj_1", kind: "paper" as const };
	const full: SubjectProgress = {
		steps: outlineSteps({ sections: SECTIONS, current: 2 }),
		practice: { posed: 2, active: true, outcomes: { solved: 1, solvedWithHints: 0, movedOn: 0, surrendered: 0, dismissed: 0 }, recent: [{ statement: "Derive the loss.", outcome: null }, { statement: "Why denoise?", outcome: "solved" }] },
		concepts: [{ id: "n_1", name: "Diffusion over coordinates", statement: "AF3 denoises raw atom coordinates instead of predicting torsion angles." }],
	};

	it("shows sections with their state, practice outcomes, and concepts", () => {
		const html = renderToStaticMarkup(<SubjectProgressBody subject={view} progress={full} />);
		assert.match(html, /Section 2 of 4/);
		assert.deepEqual([...html.matchAll(/<li data-state="(\w+)"/g)].map((m) => m[1]), ["done", "current", "upcoming", "upcoming"]);
		assert.match(html, /The diffusion module<span class="sr-only"> \(you are here\)/);
		assert.match(html, /2 problems/);
		assert.match(html, /In progress/);
		assert.match(html, /Diffusion over coordinates/);
		assert.match(html, /1 on your map/);
		assert.ok(!html.includes("uppercase"));
	});

	it("an untouched subject points to where each part starts", () => {
		const html = renderToStaticMarkup(<SubjectProgressBody subject={view} progress={{ steps: null, practice: null, concepts: [], understanding: null }} />);
		assert.match(html, /once the walkthrough has mapped the paper/);
		assert.match(html, /href="\/subject\/subj_1\?mode=walkthrough"/);
		assert.match(html, /No problems yet/);
		assert.match(html, /href="\/subject\/subj_1\?mode=practice"/);
		const topic = renderToStaticMarkup(<SubjectProgressBody subject={{ id: "subj_2", kind: "topic" }} progress={{ steps: null, practice: null, concepts: [], understanding: null }} />);
		assert.match(topic, /found out what you know/);
	});

	it("the transcript marks each section start with one quiet line", () => {
		const part = { type: "tool-outline", state: "output-available", toolCallId: "c", output: { sections: SECTIONS, current: 2 } };
		const html = renderToStaticMarkup(<OutlineCard part={part} />);
		assert.match(html, /Section 2 of 4/);
		assert.match(html, /The diffusion module/);
		assert.equal(renderToStaticMarkup(<OutlineCard part={{ ...part, state: "input-available", output: undefined }} />), "");
	});
});
