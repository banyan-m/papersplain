/**
 * Server-side subject entries (papers and topics) for the transport layer
 * (app/api/subjects*, app/subject/[id]).
 *
 * A subject owns one conversation per mode. This module is the choreography
 * around the two stores: creating a subject from the New box's text, giving
 * a mode its conversation on the first message, filing pre-subject sessions,
 * the sidebar list, deletion, and the paragraph each conversation's agent is
 * told about what it belongs to.
 */

import {
	SUBJECT_MODES,
	chatShapeFor,
	modeOfChat,
	paperSourceOf,
	paperTitleFromSource,
	type ChatRecord,
	type ChatSummary,
	type SubjectListItem,
	type SubjectMode,
	type SubjectRecord,
} from "../core/contracts.ts";
import type { GraphContextPick } from "../core/native-messages.ts";
import { outlineOf, outlineSteps, planSteps, practiceResults, stepPosition, type ProgressStep, type SubjectProgress } from "../core/subject-progress.ts";
import { chatPaperKey, readManifest, setChatPaper } from "../agent/subagents/paper-cache-store.ts";
import { paperFormulaIndex } from "../core/paper-cache.ts";
import { paperOutline } from "../core/paper-document.ts";
import { isNotebookEmpty, notebookText } from "../core/notebook.ts";
import { paperConverterKeys } from "../agent/subagents/paper-document.ts";
import { keyValue } from "./keys.ts";
import { createSession, deleteChatSession, titleFromPrompt, type ChatDeleteMode, type ChatDeleteOutcome } from "./chats.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

// The paper converter uses Mistral OCR when a Mistral key is saved
// (agent/subagents/paper-document.ts); the key lives in this layer.
paperConverterKeys.mistral = () => keyValue("MISTRAL_API_KEY");

/** At most this many of a subject's own propositions seed its practice. */
const PRACTICE_PICK_LIMIT = 24;

/** A subject's shown conversations that still exist, by mode. */
function liveChats(subject: SubjectRecord): Partial<Record<SubjectMode, ChatRecord>> {
	const out: Partial<Record<SubjectMode, ChatRecord>> = {};
	for (const mode of SUBJECT_MODES) {
		const id = subject.chats[mode];
		const chat = id ? stores.chatStore.getChat(id) : null;
		if (chat) out[mode] = chat;
	}
	return out;
}

/**
 * Keep the subject's paper up to date (owner report, 2026-11-19: every mode
 * must have the paper once ANY conversation in the subject has it).
 *
 * A PDF's cache key is known only once a conversation has read it (the
 * agent layer records it per session). The first time it is seen it is
 * copied up to the subject together with where the file is, and every other
 * conversation of the subject is linked to the same cache — so figures, toy
 * data and formula cards are theirs too. This holds for a topic that had a
 * PDF brought into it as much as for a paper. A subject that began as a
 * topic only because its first message wrapped the PDF in a sentence is a
 * paper: it is corrected here.
 */
function withPaperKey(subject: SubjectRecord): SubjectRecord {
	let current = subject;
	const chatIds = [...Object.values(subject.chats), ...(subject.shelved ?? [])].filter((id): id is string => !!id);
	if (!current.paperKey) {
		for (const id of chatIds) {
			const key = chatPaperKey(id);
			if (!key) continue;
			const file = readManifest(key)?.source;
			current = stores.subjectStore.setPaper(current.id, { paperKey: key, ...(current.source ? {} : file ? { source: file } : {}) }) ?? current;
			break;
		}
	}
	if (current.kind === "topic") {
		const walkthrough = current.chats.walkthrough ? stores.chatStore.getChat(current.chats.walkthrough) : null;
		const named = walkthrough ? paperSourceOf(firstUserText(walkthrough)) : null;
		if (named) current = stores.subjectStore.setPaper(current.id, { kind: "paper", source: current.source ?? named, ...(current.title === walkthrough!.title ? { title: paperTitleFromSource(named) } : {}) }) ?? current;
	}
	if (current.paperKey) for (const id of chatIds) if (chatPaperKey(id) !== current.paperKey && stores.chatStore.getChat(id)) setChatPaper(id, current.paperKey);
	return current;
}

/** The learner's first message in a conversation, as text. */
function firstUserText(chat: ChatRecord): string {
	for (const message of chat.messages) {
		const m = message as { role?: string; content?: unknown };
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content)) return m.content.map((part) => (typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
	}
	return chat.title;
}

/** Where the subject's PDF can be read right now: the file the cache was
 *  built from when it is known (for a link, the downloaded copy), else what
 *  the learner gave. */
function paperLocation(subject: SubjectRecord): string | null {
	const cached = subject.paperKey ? readManifest(subject.paperKey)?.source : undefined;
	return cached ?? subject.source ?? null;
}

export function getSubject(id: string): SubjectRecord | null {
	const subject = stores.subjectStore.getSubject(id);
	return subject ? withPaperKey(subject) : null;
}

export function subjectOfChat(chatId: string): SubjectRecord | null {
	const subjectId = stores.chatStore.getChat(chatId)?.subjectId;
	return subjectId ? getSubject(subjectId) : null;
}

/** The conversation for a mode, or null when the mode has none yet (or its
 *  record is gone). */
export function subjectChat(subject: SubjectRecord, mode: SubjectMode): ChatRecord | null {
	const id = subject.chats[mode];
	return id ? stores.chatStore.getChat(id) : null;
}

/** The mode touched most recently — where opening the subject lands. */
function lastModeOf(chats: Partial<Record<SubjectMode, { updatedAt: string }>>): SubjectMode {
	let best: SubjectMode = "walkthrough";
	let bestAt = "";
	for (const mode of SUBJECT_MODES) {
		const at = chats[mode]?.updatedAt;
		if (at && at > bestAt) { best = mode; bestAt = at; }
	}
	return best;
}

export function defaultModeOf(subject: SubjectRecord): SubjectMode {
	return lastModeOf(liveChats(subject));
}

/**
 * File every session that predates subjects (conversion, owner 2026-11-19).
 * Paper sessions on the same PDF share one paper; every other session becomes
 * its own subject, named after it. Newest first, so where two sessions
 * compete for a mode the newest is shown and the older one is shelved (kept
 * on disk, not listed). Idempotent: a filed session is never touched again.
 */
export function fileLooseChats(summaries: readonly ChatSummary[] = stores.chatStore.listChats()): void {
	const loose = summaries.filter((c) => !c.subjectId);
	if (loose.length === 0) return;
	const byPaper = new Map<string, SubjectRecord>();
	for (const subject of stores.subjectStore.listSubjects()) if (subject.paperKey) byPaper.set(subject.paperKey, subject);
	for (const chat of loose) {
		try {
			const key = chat.kind === "paper" ? chatPaperKey(chat.id) : null;
			let subject = key ? byPaper.get(key) ?? null : null;
			if (!subject) {
				const source = chat.kind === "paper" ? paperSourceOf(chat.title) : null;
				subject = stores.subjectStore.createSubject({
					kind: chat.kind === "paper" ? "paper" : "topic",
					title: source ? paperTitleFromSource(source) : chat.title,
					...(source ? { source } : {}),
					...(key ? { paperKey: key } : {}),
				});
				if (key) byPaper.set(key, subject);
			}
			const mode = modeOfChat(chat);
			const updated = subject.chats[mode]
				? stores.subjectStore.shelveChat(subject.id, chat.id)
				: stores.subjectStore.setChat(subject.id, mode, chat.id);
			if (updated && key) byPaper.set(key, updated);
			stores.chatStore.setSubject(chat.id, subject.id);
		} catch (err) {
			// One unreadable session must not block the rest (or the sidebar).
			console.error(`[subjects] could not file session ${chat.id}:`, err);
		}
	}
}

/** The sidebar list: every paper and topic, newest activity first. */
export function listSubjectItems(): SubjectListItem[] {
	const summaries = stores.chatStore.listChats();
	if (summaries.some((c) => !c.subjectId)) fileLooseChats(summaries);
	const byId = new Map(stores.chatStore.listChats().map((c) => [c.id, c]));
	return stores.subjectStore
		.listSubjects()
		.map((subject): SubjectListItem => {
			const chats: Partial<Record<SubjectMode, ChatSummary>> = {};
			for (const mode of SUBJECT_MODES) {
				const chat = byId.get(subject.chats[mode] ?? "");
				if (chat) chats[mode] = chat;
			}
			const shown = Object.values(chats);
			const walkthrough = chats.walkthrough ? stores.chatStore.getChat(chats.walkthrough.id) : null;
			const position = walkthrough ? stepPosition(walkthroughSteps(walkthrough)) : null;
			return {
				id: subject.id,
				kind: subject.kind,
				title: subject.title,
				updatedAt: [subject.updatedAt, ...shown.map((c) => c.updatedAt)].sort().at(-1)!,
				modes: SUBJECT_MODES.filter((mode) => chats[mode] !== undefined),
				lastMode: lastModeOf(chats),
				busy: shown.some((c) => isTurnRunning(c.id)),
				pendingQuestion: shown.some((c) => c.pendingQuestion),
				pendingProblem: shown.some((c) => c.pendingProblem),
				...(position ? { position } : {}),
			};
		})
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The New box (owner, 2026-11-19): a link or a PDF path is a paper, anything
 * else is a topic. A paper already in the list under the same link or path
 * is reopened, not duplicated. (The same PDF reached by two different paths
 * is only recognized once a conversation has read it; the file is not opened
 * here, so file-access rules stay with the reader.)
 */
export function subjectFromText(text: string): { subject: SubjectRecord; existing: boolean } {
	const source = paperSourceOf(text);
	if (!source) return { subject: stores.subjectStore.createSubject({ kind: "topic", title: titleFromPrompt(text) }), existing: false };
	const match = stores.subjectStore.listSubjects().find((s) => s.kind === "paper" && s.source === source);
	if (match) return { subject: match, existing: true };
	return { subject: stores.subjectStore.createSubject({ kind: "paper", title: paperTitleFromSource(source), source }), existing: false };
}

/** Propositions that came up in this subject's own conversations — what a
 *  practice conversation here should draw on. Most recent first. */
function subjectPropositions(subject: SubjectRecord, limit = PRACTICE_PICK_LIMIT): GraphContextPick[] {
	const own = new Set([...Object.values(subject.chats), ...(subject.shelved ?? [])].filter((id): id is string => !!id));
	if (own.size === 0) return [];
	return stores.graphStore
		.readNodes()
		.filter((node) => node.provenance.some((point) => own.has(point.chatId)))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, limit)
		.map((node) => ({ id: node.id, name: node.name, statement: node.statement }));
}

/**
 * Give a mode its conversation (called with the first message sent in it).
 * If the mode already has one, that conversation is returned unchanged.
 * A paper's conversations are linked to its cache at birth, so figures and
 * toy data made in another mode are there from the first turn. Practice
 * starts from the subject's own propositions when it has any.
 */
export function startSubjectChat(subjectId: string, mode: SubjectMode, title: string): ChatRecord | null {
	const subject = getSubject(subjectId);
	if (!subject) return null;
	const existing = subjectChat(subject, mode);
	if (existing) return existing;
	const shape = chatShapeFor(subject.kind, mode);
	const chat = createSession({
		title,
		kind: shape.kind === "teach" ? undefined : shape.kind,
		paperMode: shape.paperMode,
		picks: mode === "practice" ? subjectPropositions(subject) : [],
		subjectId: subject.id,
	});
	if (subject.paperKey) setChatPaper(chat.id, subject.paperKey);
	stores.subjectStore.setChat(subject.id, mode, chat.id);
	return chat;
}

/**
 * What a conversation's agent is told about the subject it belongs to —
 * appended to its system prompt each turn. Undefined when there is nothing
 * to add (an unfiled session; a topic's walkthrough with no paper).
 *
 * The paper paragraph is what makes the three modes share the paper: it
 * names the file, says it is already here, and forbids asking for it.
 */
/** What each agent is told about its subject, with the shared notebook
 *  (what the learner's other conversations on it have established). */
export function subjectPromptAppendix(chatId: string): string | undefined {
	const base = subjectAppendixBase(chatId);
	const chat = stores.chatStore.getChat(chatId);
	const notebook = notebookText(chat?.subjectId ? getSubject(chat.subjectId)?.notebook : undefined);
	if (!notebook) return base;
	const section = [
		"## Notebook: what is known about this learner here",
		"",
		"Kept across all of his conversations on this subject (walkthrough, chat, practice) and rewritten after each exchange. Use it: do not re-explain what he has shown he understands, come back to what is shaky, and pick up where it says. Do not read it out to him or mention that it exists.",
		"",
		notebook,
	].join("\n");
	return base ? `${base}\n\n${section}` : section;
}

function subjectAppendixBase(chatId: string): string | undefined {
	const chat = stores.chatStore.getChat(chatId);
	const subject = chat?.subjectId ? getSubject(chat.subjectId) : null;
	if (!chat || !subject) return undefined;
	const mode = modeOfChat(chat);
	const location = paperLocation(subject);
	const paperLines = (): string[] => {
		const lines: string[] = [];
		const converted = Boolean(subject.paperKey && readManifest(subject.paperKey)?.document);
		if (location) {
			lines.push(
				`The paper is this file: \`${location}\`.${subject.source && subject.source !== location ? ` (The learner gave it as \`${subject.source}\`.)` : ""} It is already on this machine. Read it with \`paper\`${converted ? "" : " (pass that exact path the first time)"}: its outline first, then the sections you need. NEVER ask the learner to upload, attach, paste or send the paper, and never say you do not have it: read it.`,
			);
		} else {
			lines.push("The learner has not given the paper's file or link yet. Only in that case, ask for it once (a link or a PDF path; the attach button is in the message box).");
		}
		// The converted paper's outline, so no conversation has to ask for it.
		const manifest = subject.paperKey ? readManifest(subject.paperKey) : null;
		if (manifest?.document) lines.push("The paper has already been converted to text. Its outline:", "", paperOutline(manifest.document, manifest.figures ?? []), "");
		// Formula cards prepared for the paper in the background (the
		// per-paper pass). Absent until it has finished.
		if (mode !== "practice") {
			const formulas = subject.paperKey ? readManifest(subject.paperKey)?.formulas : undefined;
			const own = paperFormulaIndex(formulas);
			if (own) lines.push(`Formula cards already prepared for this paper's own equations (show one with \`formula\`, by name; check it against the paper before relying on it): ${own}.`);
			if (formulas && formulas.library.length > 0) lines.push(`Library formula cards this paper uses: ${formulas.library.join(", ")}.`);
		}
		return lines;
	};
	if (subject.kind === "paper") {
		const lines = [
			"## This conversation's paper",
			"",
			`This conversation is about one paper, "${subject.title}".`,
			...paperLines(),
			"The learner has separate conversations on this same paper (a walkthrough, a free chat, a practice conversation). You see only this one. Figures and toy data already made for the paper are shared and available here.",
		];
		if (mode === "practice") lines.push("Pose problems on this paper's method, claims and evidence. If no propositions were picked for this conversation, read the paper first and pose from what it says.");
		else lines.push("Whatever the learner's first message says, the paper is the one above: read it before answering about it.");
		return lines.join("\n");
	}
	if (mode === "walkthrough" && !location) return undefined;
	const lines = [
		"## This conversation's topic",
		"",
		`This conversation is about one topic: "${subject.title}". The learner has separate conversations on the same topic (a guided walkthrough, a free chat, a practice conversation). You see only this one.`,
	];
	if (location) lines.push("The learner brought a PDF into this topic in one of those conversations.", ...paperLines());
	if (mode === "chat") {
		lines.push(
			location
				? "The learner leads: answer what they ask about this topic accurately and plainly, from the PDF where it bears on the question. Say when you are unsure, never quiz or grade, and make a visual only when it answers the question better than a paragraph would."
				: "There is no paper to read here, so the instructions about reading the paper first and staying inside the paper's own text do not apply. Everything else does: the learner leads, you answer what they ask about this topic accurately and plainly, you say when you are unsure, you never quiz or grade, and you make a visual only when it answers the question better than a paragraph would. If the learner brings a paper or a file into the conversation, read it before speaking about it.",
		);
	} else if (mode === "practice") {
		lines.push("Pose problems on this topic. If no propositions were picked for this conversation, the topic itself is the material.");
	}
	return lines.join("\n");
}

/** The walkthrough's steps: a paper's recorded outline, or a topic's plan. */
function walkthroughSteps(chat: ChatRecord): ProgressStep[] | null {
	const outline = outlineOf(chat.messages);
	if (outline) return outlineSteps(outline);
	return chat.tree && chat.tree.nodes.length > 0 ? planSteps(chat.tree, chat.messages) : null;
}

/**
 * The Progress view's data (owner, 2026-11-19): existing records only — how
 * far the walkthrough is, how practice went, and what the conversations
 * added to the map. No model call and no judgement of understanding.
 */
export function subjectProgress(subject: SubjectRecord): SubjectProgress {
	const walkthrough = subjectChat(subject, "walkthrough");
	const practice = subjectChat(subject, "practice");
	return {
		steps: walkthrough ? walkthroughSteps(walkthrough) : null,
		practice: practice ? practiceResults(practice.messages) : null,
		concepts: subjectPropositions(subject, Number.POSITIVE_INFINITY),
		understanding: isNotebookEmpty(subject.notebook)
			? null
			: { solid: subject.notebook!.solid, shaky: subject.notebook!.shaky, asked: subject.notebook!.asked, next: subject.notebook!.next, updatedAt: subject.notebook!.updatedAt },
	};
}

export type SubjectDeleteOutcome =
	| { ok: true; chatsRemoved: number; graphRevision: number }
	| { ok: false; status: number; code: string; error: string };

/**
 * Delete a paper or topic with every conversation in it (shown and shelved).
 * Each conversation goes through the ordinary session deletion (its gates,
 * its renders, its link to the paper). The paper's shared cache is kept, as
 * it is when a single session is deleted. If any conversation refuses
 * (running work), nothing more is removed and the subject stays.
 */
export async function deleteSubject(id: string, mode: ChatDeleteMode): Promise<SubjectDeleteOutcome> {
	const subject = stores.subjectStore.getSubject(id);
	if (!subject) return { ok: false, status: 404, code: "not_found", error: "No such paper or topic" };
	let chatsRemoved = 0;
	for (const chatId of [...Object.values(subject.chats), ...(subject.shelved ?? [])]) {
		if (!chatId || !stores.chatStore.getChat(chatId)) continue;
		const outcome: ChatDeleteOutcome = await deleteChatSession(chatId, mode);
		if (!outcome.ok) return { ok: false, status: outcome.status, code: outcome.code, error: outcome.error };
		stores.subjectStore.forgetChat(id, chatId);
		chatsRemoved++;
	}
	stores.subjectStore.deleteSubject(id);
	return { ok: true, chatsRemoved, graphRevision: graphRevision() };
}
