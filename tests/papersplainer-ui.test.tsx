/**
 * papersplainer UI: the paper draft view, the create call it makes, and
 * the cards that show a rendered animation or structure.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup as plainMarkup } from "react-dom/server";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { ChatActionsContext } from "../components/chat.tsx";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { isMoleculeDetails, ManimOutputCard, MoleculeCard, renderFileUrl } from "../components/artifacts/render-card.tsx";
import { sectionedSegments } from "../components/settings/agent-section.tsx";
import { renderEnvBanner } from "../components/render-env-setup.tsx";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
beforeEach(() => {
	const data = new Map<string, string>();
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => { data.set(key, value); },
		removeItem: (key: string) => { data.delete(key); },
	} });
});
afterEach(() => {
	if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "sessionStorage");
});

function fakeFetch(id: string) {
	const calls: { url: string; body: unknown }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify({ id }), { status: 200 });
	}) as typeof fetch;
	return { f, calls };
}

const inChat = (node: React.ReactNode) =>
	plainMarkup(
		<ChatActionsContext.Provider value={{ chatId: "chat_abc", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} }}>
			{node}
		</ChatActionsContext.Provider>,
	);

describe("the paper draft view", () => {
	it("creates a paper session in the chosen mode", async () => {
		const walk = fakeFetch("c_walk");
		assert.equal(await startDraftSession("~/papers/a.pdf", walk.f, "paper"), "/chat/c_walk");
		assert.deepEqual(walk.calls[0]!.body, { title: "~/papers/a.pdf", kind: "paper", paperMode: "walkthrough" });
		const chat = fakeFetch("c_chat");
		await startDraftSession("https://arxiv.org/abs/1706.03762", chat.f, "paper", undefined, undefined, undefined, "chat");
		assert.deepEqual(chat.calls[0]!.body, { title: "https://arxiv.org/abs/1706.03762", kind: "paper", paperMode: "chat" });
	});

	it("teach and practice creation is unchanged", async () => {
		const teach = fakeFetch("c_t");
		await startDraftSession("orbital mechanics", teach.f);
		assert.deepEqual(teach.calls[0]!.body, { title: "orbital mechanics" });
		const practice = fakeFetch("c_p");
		await startDraftSession("integrals", practice.f, "practice");
		assert.deepEqual(practice.calls[0]!.body, { title: "integrals", kind: "practice" });
	});

	it("shows the paper copy and the walkthrough | free chat switch", () => {
		const html = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="paper" paperMode="walkthrough" onPaperMode={() => {}} />,
		);
		assert.match(html, /New paper session/);
		assert.match(html, /one section at a time/);
		assert.match(html, /data-testid="paper-mode-walkthrough"[^>]*aria-pressed="true"/);
		assert.match(html, /data-testid="paper-mode-chat"[^>]*aria-pressed="false"/);
		assert.match(html, /Paste the paper&#x27;s PDF path or link/);
	});

	it("the teach draft has no paper switch", () => {
		const html = renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} />);
		assert.doesNotMatch(html, /paper-mode-switch/);
	});
});

describe("render cards", () => {
	it("builds a render URL only for plain render file names", () => {
		assert.equal(renderFileUrl("chat_abc", "job_1.mp4"), "/api/chats/chat_abc/renders/job_1.mp4");
		assert.equal(renderFileUrl("chat_abc", "../x.mp4"), null);
		assert.equal(renderFileUrl(undefined, "job_1.mp4"), null);
	});

	it("an animation plays from the session's renders route", () => {
		const html = inChat(<ManimOutputCard output={{ title: "Matrix fill", file: "job_1.mp4", durationSec: 20 }} />);
		assert.match(html, /<video[^>]*src="\/api\/chats\/chat_abc\/renders\/job_1\.mp4"/);
		assert.match(html, /Matrix fill/);
	});

	it("a failed animation shows the reason, not a player", () => {
		const html = inChat(<ManimOutputCard output={{ title: "Matrix fill", file: "", notes: "FAILED: NameError" }} />);
		assert.match(html, /data-testid="manim-card-failed"/);
		assert.match(html, /FAILED: NameError/);
		assert.doesNotMatch(html, /<video/);
	});

	const DETAILS = { title: "Haemoglobin", file: "mol_c1.cif", format: "cif", style: "cartoon", color: "chain", source: "PDB 4HHB", atoms: 4558, residues: 574, chains: ["A", "B", "C", "D"] };

	it("a structure shows in the interactive viewer with its source and size", () => {
		const html = inChat(<MoleculeCard part={{ type: "tool-molecule", state: "output-available", toolCallId: "c1", output: DETAILS }} />);
		assert.match(html, /data-testid="molecule-viewer"/);
		assert.match(html, /Haemoglobin · PDB 4HHB · 574 residues, 4 chains · drag to rotate, scroll to zoom/);
		assert.match(html, /href="\/api\/chats\/chat_abc\/renders\/mol_c1\.cif"/);
	});

	it("an unusable record never reaches the viewer", () => {
		assert.equal(isMoleculeDetails(DETAILS), true);
		assert.equal(isMoleculeDetails({ ...DETAILS, file: "../../auth.json" }), false);
		assert.equal(isMoleculeDetails({ ...DETAILS, style: "wireframe" }), false);
		assert.equal(isMoleculeDetails(null), false);
		const html = inChat(<MoleculeCard part={{ type: "tool-molecule", state: "output-available", toolCallId: "c1", output: { ...DETAILS, file: "../x.cif" } }} />);
		assert.match(html, /could not be displayed/);
		assert.doesNotMatch(html, /molecule-viewer/);
	});
});

describe("settings: the guide's prompts", () => {
	it("lists a Paper guide section when the server sends one, and tolerates older views", () => {
		const seg = (path: string, shared = false) => ({ path, sourceText: "x", overrideText: null, enabled: false, shared });
		const base = { teacher: [seg("teacher/20-teaching.md")], prober: [seg("prober/10-probe-doctrine.md")], practice: [seg("practice/00-base.md")] };
		assert.deepEqual(sectionedSegments(base).map((s) => s.id), ["teacher", "prober", "practice", "shared"]);
		const withGuide = sectionedSegments({ ...base, guide: [seg("guide/00-base.md"), seg("shared/40-formatting.md", true)] });
		assert.deepEqual(withGuide.map((s) => s.label), ["Teacher", "Prober", "Practice", "Paper guide", "Shared"]);
		assert.equal(withGuide.at(-1)!.segments[0]!.usageHint, "Used by Paper guide");
	});
});

describe("first-launch animation setup", () => {
	it("shows nothing when ready, the current step while installing, and the reason on failure", () => {
		assert.deepEqual(renderEnvBanner(null), { kind: "hidden" });
		assert.deepEqual(renderEnvBanner({ manim: { ready: true, installing: false } }), { kind: "hidden" });
		assert.deepEqual(renderEnvBanner({ manim: { ready: false, installing: true }, activity: { manim: "installing manim" } }), { kind: "installing", step: "installing manim" });
		assert.deepEqual(renderEnvBanner({ manim: { ready: false, installing: true } }), { kind: "installing", step: "starting" });
		assert.deepEqual(renderEnvBanner({ manim: { ready: false, installing: false }, errors: { manim: "no network" } }), { kind: "failed", reason: "no network" });
		assert.deepEqual(renderEnvBanner({ manim: { ready: false, installing: false } }), { kind: "hidden" });
	});
});
