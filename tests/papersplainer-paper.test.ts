/**
 * papersplainer paper sessions: the "paper" chat kind, the guide agent
 * (walkthrough | free chat), paper links, and one end-to-end turn in which
 * the guide shows a structure that lands in the session.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { PATHS } from "../config.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { composeInstructions, createGuideAgent, guideModeInstructions } from "../src/agent/teacher-agent.ts";
import { createGuideTools, createTeacherTools } from "../src/agent/tools.ts";
import { downloadPaper, paperPdfUrl, resolvePaperOrSourcePath } from "../src/agent/tools/paper-fetch.ts";
import { safeFetchOverride } from "../src/agent/tools/safe-fetch.ts";
import { chatRendersDir } from "../src/agent/subagents/render-env.ts";
import type { MoleculeDetails } from "../src/core/contracts.ts";
import { projectView } from "../src/core/view.ts";
import { isValidSegmentPath } from "../src/core/prompt-segments.ts";
import { listSourceSegments } from "../src/agent/prompt-segments.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { GET as getRender } from "../app/api/chats/[id]/renders/[file]/route.ts";
import { POST as createChatRoute } from "../app/api/chats/route.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const JOBS_DIR = path.join(PATHS.data, "jobs");
const createdChats: string[] = [];
const createdJobs: string[] = [];
const createdFiles: string[] = [];
after(() => {
	for (const id of createdChats) {
		fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
		fs.rmSync(chatRendersDir(id), { recursive: true, force: true });
	}
	for (const id of createdJobs) fs.rmSync(path.join(JOBS_DIR, `${id}.json`), { force: true });
	for (const file of createdFiles) fs.rmSync(file, { force: true });
});

function scriptedModel(turns: Array<{ toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>; text?: string }>): PiEngine {
	const steps: FauxResponseStep[] = turns.map((step) =>
		step.toolCalls
			? fauxAssistantMessage(
					step.toolCalls.map((c) => fauxToolCall(c.toolName, c.input as ToolCall["arguments"], { id: c.toolCallId })),
					{ stopReason: "toolUse" },
				)
			: fauxAssistantMessage(step.text ?? ""),
	);
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 50);
		};
		tick();
	});
}

describe("paper session records", () => {
	it("a paper chat stores its kind and mode; teach and practice are unchanged", () => {
		const walk = chatStore.createChat("Paper: walkthrough", "paper");
		const chat = chatStore.createChat("Paper: chat", "paper", "chat");
		const teach = chatStore.createChat("Teach");
		const practice = chatStore.createChat("Practice", "practice");
		createdChats.push(walk.id, chat.id, teach.id, practice.id);
		assert.equal(chatStore.getChat(walk.id)?.kind, "paper");
		assert.equal(chatStore.getChat(walk.id)?.paperMode, "walkthrough");
		assert.equal(chatStore.getChat(chat.id)?.paperMode, "chat");
		assert.equal(chatStore.getChat(teach.id)?.kind, undefined);
		assert.equal(chatStore.getChat(teach.id)?.paperMode, undefined);
		assert.equal(chatStore.getChat(practice.id)?.kind, "practice");
		assert.equal(chatStore.getChat(practice.id)?.paperMode, undefined);
	});

	it("POST /api/chats creates a paper session in the requested mode", async () => {
		const res = await createChatRoute(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "~/papers/alphafold.pdf", kind: "paper", paperMode: "chat" }),
		}));
		assert.equal(res.status, 200);
		const { id } = await res.json() as { id: string };
		createdChats.push(id);
		assert.equal(chatStore.getChat(id)?.kind, "paper");
		assert.equal(chatStore.getChat(id)?.paperMode, "chat");
	});
});

describe("the guide's prompt and tools", () => {
	it("composes its own base plus the allowed shared fragments, never the quiz mechanics", () => {
		const paths = listSourceSegments("guide").map((s) => s.path);
		assert.deepEqual(paths.filter((p) => p.startsWith("guide/")), ["guide/00-base.md", "guide/10-reading.md", "guide/20-explaining.md", "guide/25-paper-material.md", "guide/30-visuals.md"]);
		assert.ok(!paths.includes("system-prompt.md"), "the teaching base stays out");
		assert.ok(!paths.includes("shared/20-question-tools.md"), "quiz mechanics stay out");
		assert.ok(!paths.includes("shared/25-confidence.md"));
		assert.ok(paths.includes("shared/40-formatting.md"));
		assert.ok(paths.every(isValidSegmentPath));
		const prompt = composeInstructions("guide");
		assert.match(prompt, /You never quiz or grade him/);
		assert.match(prompt, /fetch_paper/);
	});

	it("each mode has its own instruction", () => {
		assert.match(guideModeInstructions("walkthrough"), /STOP and wait/);
		assert.match(guideModeInstructions("chat"), /The learner leads/);
	});

	it("registers reading and showing tools, and no graded or planning tools", () => {
		const ctx = { chatId: "c", chatStore, jobStore, spawn: () => {} };
		const names = Object.keys(createGuideTools(ctx)).sort();
		assert.deepEqual(names, ["ask_user_question", "demo", "derivation", "fetch_paper", "find", "formula", "grep", "ls", "manim", "molecule", "outline", "paper", "paper_figure", "pdf", "read", "research", "show_image", "toy_data", "visual"]);
		for (const graded of ["quiz", "explain", "probe", "recall", "plan_init", "probe_done", "problem", "conclude"]) {
			assert.ok(!names.includes(graded), `${graded} must not be in a paper session`);
		}
	});

	it("the settings tool toggles still apply", () => {
		const ctx = { chatId: "c", chatStore, jobStore, spawn: () => {} };
		assert.ok(!("research" in createGuideTools(ctx, { research: false })));
	});

	it("teach sessions do not gain the render tools", () => {
		const names = Object.keys(createTeacherTools({ chatId: "c", chatStore, jobStore, spawn: () => {} }));
		assert.ok(!names.includes("manim"));
		assert.ok(!names.includes("molecule"));
		assert.ok(!names.includes("fetch_paper"));
		assert.ok(!names.includes("toy_data"));
		assert.ok(!names.includes("paper_figure"));
	});
});

describe("paper links", () => {
	it("rewrites preprint pages to their PDF and leaves other links alone", () => {
		assert.equal(paperPdfUrl("https://arxiv.org/abs/1706.03762"), "https://arxiv.org/pdf/1706.03762");
		assert.equal(paperPdfUrl("https://arxiv.org/abs/1706.03762v5"), "https://arxiv.org/pdf/1706.03762v5");
		assert.equal(paperPdfUrl("https://arxiv.org/pdf/1706.03762.pdf"), "https://arxiv.org/pdf/1706.03762");
		assert.equal(paperPdfUrl("https://www.biorxiv.org/content/10.1101/2021.10.04.463034v2"), "https://www.biorxiv.org/content/10.1101/2021.10.04.463034v2.full.pdf");
		assert.equal(paperPdfUrl("https://www.biorxiv.org/content/10.1101/2021.10.04.463034v2.full"), "https://www.biorxiv.org/content/10.1101/2021.10.04.463034v2.full.pdf");
		assert.equal(paperPdfUrl("https://www.medrxiv.org/content/10.1101/2020.03.01.20029074v1.full.pdf"), "https://www.medrxiv.org/content/10.1101/2020.03.01.20029074v1.full.pdf");
		assert.equal(paperPdfUrl("https://example.org/files/paper.pdf"), "https://example.org/files/paper.pdf");
	});

	it("saves a PDF into the app's papers folder, readable regardless of file-access folders", async () => {
		const requested: string[] = [];
		safeFetchOverride.current = async (url) => {
			requested.push(url);
			return new Response(Buffer.from("%PDF-1.7\nfake body"), { status: 200, headers: { "content-type": "application/pdf" } });
		};
		try {
			const saved = await downloadPaper("https://arxiv.org/abs/1706.03762");
			createdFiles.push(saved.path);
			assert.deepEqual(requested, ["https://arxiv.org/pdf/1706.03762"]);
			assert.equal(path.dirname(saved.path), PATHS.papers);
			assert.match(path.basename(saved.path), /^1706\.03762-[a-z0-9]+\.pdf$/);
			assert.equal(resolvePaperOrSourcePath(saved.path), fs.realpathSync(saved.path));
		} finally {
			safeFetchOverride.current = undefined;
		}
	});

	it("refuses a link that returns a web page instead of a PDF", async () => {
		safeFetchOverride.current = async () => new Response("<html>Sign in to continue</html>", { status: 200, headers: { "content-type": "text/html" } });
		try {
			await assert.rejects(downloadPaper("https://doi.org/10.1038/s41586-021-03819-2"), /did not return a PDF/);
		} finally {
			safeFetchOverride.current = undefined;
		}
	});

	it("reports an HTTP failure", async () => {
		safeFetchOverride.current = async () => new Response("no", { status: 404, statusText: "Not Found" });
		try {
			await assert.rejects(downloadPaper("https://example.org/missing.pdf"), /HTTP 404/);
		} finally {
			safeFetchOverride.current = undefined;
		}
	});
});

describe("a paper turn end to end", () => {
	it("the guide shows a structure; the file is saved with the session, recorded on the tool part, and served", async () => {
		const chat = chatStore.createChat("Test: paper turn", "paper", "walkthrough");
		createdChats.push(chat.id);
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const structure = path.resolve("tests/helpers/helix.pdb");

		const guide = scriptedModel([
			{ toolCalls: [{ toolCallId: "call-m1", toolName: "molecule", input: { title: "Test helix", path: structure, style: "cartoon", color: "spectrum" } }] },
			{ text: "This section describes a single alpha helix of 24 residues (p. 2)." },
		]);

		const ack = await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: `Walk me through ${structure}` } }),
			}),
			(opts) =>
				createGuideAgent(
					{ chatId: chat.id, chatStore, jobStore, spawn: () => assert.fail("the molecule tool must not start a background job") },
					"walkthrough",
					{ engine: guide, messages: opts.messages },
				),
		);
		if (ack.status !== 200) assert.fail(`expected 200, got ${ack.status}: ${await ack.text()}`);
		const handle = runningTurn(chat.id);
		if (handle) await new Response(handle.subscribe()).text();
		await waitFor(() => !runningTurn(chat.id), 10_000, "the turn to settle");

		const view = projectView(chatStore.getChat(chat.id)!.messages);
		const part = view.flatMap((m) => m.parts).find((p) => p.type === "tool-molecule") as { state: string; output: unknown } | undefined;
		assert.ok(part, "the transcript carries the molecule tool part");
		assert.equal(part.state, "output-available");
		const details = part.output as MoleculeDetails;
		assert.equal(details.file, "mol_call-m1.pdb");
		assert.equal(details.style, "cartoon");
		assert.equal(details.color, "spectrum");
		assert.equal(details.residues, 24);
		assert.equal(jobStore.findJobByToolCallId(chat.id, "call-m1"), null, "no background job");

		const served = await getRender(new Request("http://test/render"), { params: Promise.resolve({ id: chat.id, file: details.file }) });
		assert.equal(served.status, 200);
		assert.match(served.headers.get("content-type") ?? "", /^text\/plain/);
		const body = await served.text();
		assert.match(body, /^ATOM/);

		const ranged = await getRender(new Request("http://test/render", { headers: { range: "bytes=0-3" } }), { params: Promise.resolve({ id: chat.id, file: details.file }) });
		assert.equal(ranged.status, 206);
		assert.equal(await ranged.text(), "ATOM");
		assert.equal(ranged.headers.get("content-range"), `bytes 0-3/${Buffer.byteLength(body)}`);
	});

	it("the renders route refuses path tricks and unknown sessions", async () => {
		const chat = chatStore.createChat("Test: render route", "paper");
		createdChats.push(chat.id);
		const get = (id: string, file: string) => getRender(new Request("http://test/render"), { params: Promise.resolve({ id, file }) });
		assert.equal((await get(chat.id, "../../settings.json")).status, 404);
		assert.equal((await get(chat.id, "missing.png")).status, 404);
		assert.equal((await get("chat_does_not_exist", "a.png")).status, 404);
		assert.equal((await get("../chats", "a.png")).status, 404);
	});
});
