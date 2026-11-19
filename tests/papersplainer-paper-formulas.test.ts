/**
 * papersplainer: the per-paper formula pass.
 *
 *   1. reading a model's reply: the JSON object, then only what validates
 *   2. one pass with a scripted model
 *   3. once per paper, stored in the paper's cache (a real PDF)
 *   4. the guide can show a prepared card by name, and is told they exist
 *
 * Runs under an isolated LH_DATA_DIR, set before any config-loading import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "papersplainer-paper-formulas-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { MAX_PAPER_CARDS, ensurePaperFormulas, extractJsonObject, runPaperFormulaPass, screenPaperFormulas } = await import("../src/agent/subagents/paper-formulas.ts");
const { paperKeyForFile, readManifest, setChatPaper, updateManifest } = await import("../src/agent/subagents/paper-cache-store.ts");
const { createFormulaTool } = await import("../src/agent/tools/formula.ts");
const { paperFormulaIndex } = await import("../src/core/paper-cache.ts");
const { subjectStore } = await import("../src/store/subjects.ts");
const { startSubjectChat, subjectPromptAppendix } = await import("../src/server/subjects.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type FormulaCard = import("../src/core/formula.ts").FormulaCard;

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const PDF = path.resolve("tests/helpers/toy-paper.pdf");
const GOOD = {
	title: "Scoring function (Eq. 2)",
	caption: "The paper's alignment score as the gap penalty changes (Eq. 2, p. 3).",
	latex: String.raw`S = m - \note{gap}{\tangle{g}}\,k`,
	parameters: { g: { value: 2, min_value: 0, max_value: 10, step: 0.5, label: "gap penalty" } },
	notes: { gap: "**gap penalty** per gapped position" },
	plot: { kind: "curve", x: { label: "gapped positions k", min: 0, max: 10 }, y: { min: -50, max: 50 }, curves: [{ expr: "40 - g * x", label: "score (m = 40)" }] },
};
const reply = (cards: Record<string, unknown>, library: unknown = ["sigmoid", "not-a-card"]) => JSON.stringify({ library, cards });

function scripted(...texts: string[]): { engine: PiEngine; calls: () => number } {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
	let calls = 0;
	const streamFn: PiEngine["streamFn"] = ((...args: Parameters<PiEngine["streamFn"]>) => { calls++; return faux.streamSimple(...args); }) as PiEngine["streamFn"];
	return { engine: { model: faux.getModel(), streamFn }, calls: () => calls };
}

describe("reading the model's reply", () => {
	it("finds the JSON object inside a fence or a sentence, and gives null for none", () => {
		assert.deepEqual(extractJsonObject('Here you go:\n```json\n{"a": {"b": "} not the end"}}\n```\nDone.'), { a: { b: "} not the end" } });
		assert.deepEqual(extractJsonObject('{"latex": "\\\\frac{1}{2}"}'), { latex: "\\frac{1}{2}" });
		assert.equal(extractJsonObject("no json here"), null);
		assert.equal(extractJsonObject('{"cut": '), null);
	});

	it("keeps known library names and cards that would draw; drops the rest with a reason", () => {
		const screened = screenPaperFormulas({
			library: ["sigmoid", "sigmoid", "nope", 3, "relu"],
			cards: {
				"Eq 2 Score": GOOD,
				"bad-plot": { ...GOOD, plot: { kind: "curve", x: { min: 0, max: 1 }, curves: [{ expr: "g * unknown" }] } },
				"bad-latex": { ...GOOD, latex: String.raw`\frac{\note{gap}{\tangle{g}}` },
				"no-plot": { ...GOOD, plot: undefined },
				sigmoid: GOOD,
				"!!!": GOOD,
			},
		});
		assert.deepEqual(screened.library, ["sigmoid", "relu"]);
		assert.deepEqual(Object.keys(screened.cards), ["eq-2-score"], "the name is normalized");
		const reasons = Object.fromEntries(screened.rejected.map((r) => [r.name, r.reason]));
		assert.match(reasons["bad-plot"]!, /reads "unknown"/);
		assert.match(reasons["bad-latex"]!, /latex does not render/);
		assert.match(reasons["no-plot"]!, /needs a plot/);
		assert.match(reasons.sigmoid!, /already taken/, "a paper card may not shadow a library card");
		assert.match(reasons["!!!"]!, /no letters or digits/);
	});

	it("caps the number of cards and survives a reply that is not an object", () => {
		const many = Object.fromEntries(Array.from({ length: MAX_PAPER_CARDS + 3 }, (_, i) => [`eq-${i}`, GOOD]));
		const screened = screenPaperFormulas({ cards: many });
		assert.equal(Object.keys(screened.cards).length, MAX_PAPER_CARDS);
		assert.equal(screened.rejected.length, 3);
		assert.deepEqual(screenPaperFormulas(null), { library: [], cards: {}, rejected: [] });
		assert.deepEqual(screenPaperFormulas({ library: "sigmoid", cards: [GOOD] }), { library: [], cards: {}, rejected: [] });
	});
});

describe("one pass", () => {
	it("asks once, with the library index and the paper's text, and reports usage", async () => {
		const { engine, calls } = scripted(`Sure.\n${reply({ "eq-2-score": GOOD })}`);
		let usage = 0;
		const result = await runPaperFormulaPass("--- Page 1 ---\n\nA toy paper about alignment scores.", { engine, onUsage: () => { usage++; } });
		assert.equal(calls(), 1);
		assert.equal(usage, 1);
		assert.deepEqual(result.library, ["sigmoid"]);
		assert.deepEqual(Object.keys(result.cards), ["eq-2-score"]);
		assert.ok(!Number.isNaN(Date.parse(result.createdAt)));
	});

	it("a reply with no JSON prepares nothing", async () => {
		const result = await runPaperFormulaPass("text", { engine: scripted("I could not read the equations.").engine });
		assert.deepEqual([result.library, result.cards, result.rejected], [[], {}, []]);
	});
});

describe("once per paper", () => {
	it("stores the result in the paper's cache and never asks again", async () => {
		const key = await paperKeyForFile(PDF);
		const first = scripted(reply({ "eq-2-score": GOOD }));
		const stored = await ensurePaperFormulas(PDF, key, { engine: first.engine });
		assert.deepEqual(Object.keys(stored!.cards), ["eq-2-score"]);
		assert.deepEqual(readManifest(key)!.formulas!.library, ["sigmoid"]);
		assert.equal(readManifest(key)!.source, PDF);

		const second = scripted(reply({}));
		const again = await ensurePaperFormulas(PDF, key, { engine: second.engine });
		assert.equal(second.calls(), 0, "the stored result is reused");
		assert.deepEqual(again, stored);
	});

	it("with no model for the pass nothing is stored, so a later session tries again", async () => {
		assert.equal(await ensurePaperFormulas(PDF, "0000000000000001", { engine: undefined }), null);
		assert.equal(readManifest("0000000000000001"), null);
	});

	it("a failing model leaves nothing stored and does not throw", async () => {
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([]); // nothing scripted: the call fails
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const original = console.error;
		console.error = () => {};
		try {
			assert.equal(await ensurePaperFormulas(PDF, "0000000000000002", { engine }), null);
		} finally {
			console.error = original;
		}
		assert.equal(readManifest("0000000000000002")?.formulas, undefined);
	});

	it("two callers at once share one pass", async () => {
		const one = scripted(reply({ "eq-2-score": GOOD }));
		const [a, b] = await Promise.all([
			ensurePaperFormulas(PDF, "0000000000000003", { engine: one.engine }),
			ensurePaperFormulas(PDF, "0000000000000003", { engine: one.engine }),
		]);
		assert.equal(one.calls(), 1);
		assert.deepEqual(a, b);
	});
});

describe("using a paper's cards", () => {
	it("the formula tool finds a prepared card by name, ahead of nothing else, and still finds library cards", async () => {
		const tool = createFormulaTool(undefined, () => ({ "eq-2-score": GOOD as never }));
		const out = (await tool.execute("c", { name: "eq-2-score" } as never, undefined)) as { details: FormulaCard };
		assert.equal(out.details.title, "Scoring function (Eq. 2)");
		assert.equal(out.details.libraryId, "eq-2-score");
		const lib = (await tool.execute("c", { name: "relu" } as never, undefined)) as { details: FormulaCard };
		assert.equal(lib.details.title, "ReLU and leaky ReLU");
		await assert.rejects(() => tool.execute("c", { name: "eq-9" } as never, undefined) as Promise<unknown>, /no card named "eq-9"/);
	});

	it("a paper's conversations are told which cards are ready; practice is not", () => {
		const subject = subjectStore.createSubject({ kind: "paper", title: "Toy paper", source: PDF, paperKey: "00000000000000aa" });
		const walkthrough = startSubjectChat(subject.id, "walkthrough", "start")!;
		assert.ok(!subjectPromptAppendix(walkthrough.id)!.includes("Formula cards"), "nothing before the pass has run");
		updateManifest("00000000000000aa", PDF, (manifest) => { manifest.formulas = { library: ["sigmoid"], cards: { "eq-2-score": GOOD as never }, createdAt: new Date().toISOString() }; });
		setChatPaper(walkthrough.id, "00000000000000aa");
		const told = subjectPromptAppendix(walkthrough.id)!;
		assert.match(told, /eq-2-score: Scoring function \(Eq\. 2\)/);
		assert.match(told, /check it against the paper/);
		assert.match(told, /Library formula cards this paper uses: sigmoid\./);
		const practice = startSubjectChat(subject.id, "practice", "start")!;
		assert.ok(!subjectPromptAppendix(practice.id)!.includes("Formula cards"));
		assert.equal(paperFormulaIndex(undefined), "");
	});
});
