/**
 * papersplainer: the paper/topic surfaces — the sidebar row, the mode
 * switch, the subject drafts and their first-message handover.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup as plainMarkup } from "react-dom/server";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { ModeSwitch, ProgressButton, type SubjectView } from "../components/mode-switch.tsx";
import { DraftShell, startSubjectDraft, subjectDraftCopy } from "../components/new-session.tsx";
import { SubjectRow, subjectMeta } from "../components/sidebar.tsx";
import { DeleteSessionBody } from "../components/delete-session-dialog.tsx";
import type { SubjectListItem } from "../src/core/index.ts";

function row(overrides: Partial<SubjectListItem>): SubjectListItem {
	return {
		id: "subj_1", kind: "paper", title: "AlphaFold 3", updatedAt: new Date().toISOString(),
		modes: ["walkthrough"], lastMode: "walkthrough", busy: false, pendingQuestion: false, pendingProblem: false,
		...overrides,
	};
}

const view = (overrides: Partial<SubjectView> = {}): SubjectView => ({ id: "subj_1", kind: "paper", title: "AlphaFold 3", mode: "walkthrough", modes: ["walkthrough"], ...overrides });

describe("SubjectRow", () => {
	it("a paper and a topic are told apart by icon; the title and age show", () => {
		const paper = plainMarkup(<SubjectRow subject={row({})} active={false} onOpen={() => {}} />);
		assert.match(paper, /data-kind="paper"/);
		assert.match(paper, /aria-label="Paper"/);
		assert.match(paper, /AlphaFold 3/);
		assert.match(paper, /just now/);
		const topic = plainMarkup(<SubjectRow subject={row({ kind: "topic", title: "Hidden Markov models" })} active={false} onOpen={() => {}} />);
		assert.match(topic, /data-kind="topic"/);
		assert.match(topic, /aria-label="Topic"/);
	});

	it("the spinner shows only while a conversation is working", () => {
		assert.ok(!plainMarkup(<SubjectRow subject={row({})} active={false} onOpen={() => {}} />).includes("braille-spinner"));
		assert.ok(plainMarkup(<SubjectRow subject={row({ busy: true })} active={false} onOpen={() => {}} />).includes("braille-spinner"));
	});

	it("the second line says what is waiting", () => {
		assert.match(subjectMeta(row({ pendingQuestion: true })), /^Waiting for input · /);
		assert.match(subjectMeta(row({ pendingProblem: true })), /^Problem waiting · /);
		assert.equal(subjectMeta(row({ busy: true })), "Working…");
		assert.equal(subjectMeta(row({})), "just now");
	});

	it("labels are sentence case, never forced uppercase", () => {
		assert.ok(!plainMarkup(<SubjectRow subject={row({})} active onOpen={() => {}} />).includes("uppercase"));
	});
});

describe("ModeSwitch", () => {
	it("three joined links in order, the current one marked", () => {
		const html = plainMarkup(<ModeSwitch subject={view({ mode: "chat", modes: ["walkthrough", "chat"] })} />);
		const labels = [...html.matchAll(/data-testid="mode-(walkthrough|chat|practice)"/g)].map((m) => m[1]);
		assert.deepEqual(labels, ["walkthrough", "chat", "practice"]);
		assert.match(html, /href="\/subject\/subj_1\?mode=walkthrough"/);
		assert.match(html, /href="\/subject\/subj_1\?mode=practice"/);
		assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
		assert.match(html, /<a[^>]*aria-current="page"[^>]*>Chat<\/a>/, "the mode on screen is the marked one");
		assert.equal((html.match(/data-started=""/g) ?? []).length, 2, "modes that already have a conversation");
		assert.match(html, />Walkthrough<\/a>.*>Chat<\/a>.*>Practice<\/a>/s);
		assert.ok(!html.includes("uppercase"));
	});

	it("the Progress button is a small labelled link to the progress view", () => {
		const html = renderToStaticMarkup(<ProgressButton subject={view()} />);
		assert.match(html, /href="\/subject\/subj_1\?view=progress"/);
		assert.match(html, /aria-label="Progress"/);
		assert.match(html, /size-7/);
	});
});

describe("subject drafts", () => {
	it("the New box asks for a paper or a topic and shows no mode switch", () => {
		const html = renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} subject={null} />);
		assert.match(html, /New paper or topic/);
		assert.match(html, /Paper link, PDF path, or a topic/);
		assert.ok(!html.includes('data-testid="mode-switch"'));
		assert.ok(!html.includes('data-testid="paper-mode-switch"'), "the old walkthrough | free chat switch is gone here");
	});

	it("a mode's first screen keeps the subject's name, the switch and the Progress button", () => {
		const html = renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} subject={view({ mode: "practice" })} mode="practice" />);
		assert.match(html, /data-testid="draft-subject-title"[^>]*>AlphaFold 3</);
		assert.match(html, /data-testid="mode-switch"/);
		assert.match(html, /data-testid="progress-button"/);
		assert.match(html, /Practice this paper/);
		assert.ok(!html.includes("Pick nodes"), "practice inside a subject draws on the subject, no node picker");
	});

	it("copy differs by kind and mode", () => {
		assert.match(subjectDraftCopy(view({ mode: "chat" })).title, /Ask about this paper/);
		assert.match(subjectDraftCopy(view({ kind: "topic", mode: "chat" })).title, /Ask about this topic/);
		assert.match(subjectDraftCopy(view({ kind: "topic", mode: "walkthrough" })).description, /what you already know/);
		assert.match(subjectDraftCopy(view({ mode: "walkthrough" })).description, /one section at a time/);
	});
});

describe("the first message of a subject draft", () => {
	const store = new Map<string, string>();
	const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	beforeEach(() => {
		store.clear();
		Object.defineProperty(globalThis, "sessionStorage", {
			configurable: true,
			value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
		});
	});
	afterEach(() => {
		if (original) Object.defineProperty(globalThis, "sessionStorage", original);
		else delete (globalThis as Record<string, unknown>).sessionStorage;
	});
	const fake = (reply: unknown, seen: { url: string; body: unknown }[]) => (async (url: RequestInfo | URL, init?: RequestInit) => {
		seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		return new Response(JSON.stringify(reply), { status: 200 });
	}) as typeof fetch;

	it("the New box creates the subject and hands the text to its walkthrough", async () => {
		const seen: { url: string; body: unknown }[] = [];
		const target = await startSubjectDraft("  https://arxiv.org/abs/2401.01234 ", null, fake({ id: "subj_9", chatId: "chat_9", opening: true }, seen));
		assert.equal(target, "/subject/subj_9?mode=walkthrough");
		assert.deepEqual(seen, [{ url: "/api/subjects", body: { text: "https://arxiv.org/abs/2401.01234" } }]);
		assert.match(store.get("lh.openingPrompt.chat_9")!, /arxiv\.org/);
	});

	it("reopening a listed paper sends nothing again", async () => {
		const target = await startSubjectDraft("https://arxiv.org/abs/2401.01234", null, fake({ id: "subj_9", chatId: "chat_9", opening: false }, []));
		assert.equal(target, "/subject/subj_9?mode=walkthrough");
		assert.equal(store.size, 0);
	});

	it("inside a subject it gives the mode on screen its conversation", async () => {
		const seen: { url: string; body: unknown }[] = [];
		const target = await startSubjectDraft("what is the loss?", view({ mode: "chat" }), fake({ id: "chat_c" }, seen));
		assert.equal(target, "/subject/subj_1?mode=chat");
		assert.deepEqual(seen, [{ url: "/api/subjects/subj_1/chats", body: { mode: "chat", title: "what is the loss?" } }]);
		assert.match(store.get("lh.openingPrompt.chat_c")!, /what is the loss/);
	});

	it("empty text does nothing; a failed creation throws so the draft stays", async () => {
		assert.equal(await startSubjectDraft("   ", null, fake({}, [])), null);
		const failing = (async () => new Response("{}", { status: 500 })) as typeof fetch;
		await assert.rejects(() => startSubjectDraft("a topic", null, failing));
	});
});

describe("deleting a paper or topic", () => {
	it("the dialog names the kind and says every conversation goes", () => {
		const html = plainMarkup(<DeleteSessionBody chat={{ id: "subj_1", title: "AlphaFold 3" }} subject="paper" traces={false} busy={false} failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />);
		assert.match(html, /Delete paper\?/);
		assert.match(html, /every conversation in it/);
		assert.match(html, /cached figures and data are kept/);
		const topic = plainMarkup(<DeleteSessionBody chat={{ id: "subj_2", title: "HMMs" }} subject="topic" traces={false} busy={false} failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />);
		assert.match(topic, /Delete topic\?/);
		assert.ok(!topic.includes("cached figures"));
	});
});
