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
import { chatPaperKey, setChatPaper } from "../agent/subagents/paper-cache-store.ts";
import { createSession, deleteChatSession, titleFromPrompt, type ChatDeleteMode, type ChatDeleteOutcome } from "./chats.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

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

/** A paper's cache key becomes known only once a conversation has read the
 *  PDF (the agent layer records it per session). Copy it up to the subject
 *  the first time it is seen, so later conversations start with the cache. */
function withPaperKey(subject: SubjectRecord): SubjectRecord {
	if (subject.kind !== "paper" || subject.paperKey) return subject;
	for (const id of [...Object.values(subject.chats), ...(subject.shelved ?? [])]) {
		const key = id ? chatPaperKey(id) : null;
		if (key) return stores.subjectStore.setPaper(subject.id, { paperKey: key }) ?? subject;
	}
	return subject;
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
function subjectPropositions(subject: SubjectRecord): GraphContextPick[] {
	const own = new Set([...Object.values(subject.chats), ...(subject.shelved ?? [])].filter((id): id is string => !!id));
	if (own.size === 0) return [];
	return stores.graphStore
		.readNodes()
		.filter((node) => node.provenance.some((point) => own.has(point.chatId)))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, PRACTICE_PICK_LIMIT)
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
 * to add: an unfiled session, or the conversation whose own first message
 * already names the paper or topic and whose agent is built for it.
 */
export function subjectPromptAppendix(chatId: string): string | undefined {
	const chat = stores.chatStore.getChat(chatId);
	const subject = chat?.subjectId ? getSubject(chat.subjectId) : null;
	if (!chat || !subject) return undefined;
	const mode = modeOfChat(chat);
	if (subject.kind === "paper") {
		const where = subject.source ? `\`${subject.source}\`` : "the PDF the learner named in another conversation on this paper";
		const lines = [
			"## This conversation's paper",
			"",
			`This conversation is about one paper, "${subject.title}". The paper is ${where}.`,
			"The learner has separate conversations on this same paper (a walkthrough, a free chat, a practice conversation). You see only this one. Figures and toy data already made for the paper are shared and available here.",
		];
		if (mode === "practice") lines.push("Pose problems on this paper's method, claims and evidence. If no propositions were picked for this conversation, read the paper first (a pdf job) and pose from what it says.");
		else lines.push("If the learner's first message does not name the paper, it is the one above: read it before answering.");
		return lines.join("\n");
	}
	if (mode === "walkthrough") return undefined;
	const lines = [
		"## This conversation's topic",
		"",
		`This conversation is about one topic, not a paper: "${subject.title}". The learner has separate conversations on the same topic (a guided walkthrough, a free chat, a practice conversation). You see only this one.`,
	];
	if (mode === "chat") {
		lines.push(
			"There is no paper to read here, so the instructions about reading the paper first and staying inside the paper's own text do not apply. Everything else does: the learner leads, you answer what they ask about this topic accurately and plainly, you say when you are unsure, you never quiz or grade, and you make a visual only when it answers the question better than a paragraph would. If the learner brings a paper or a file into the conversation, read it before speaking about it.",
		);
	} else {
		lines.push("Pose problems on this topic. If no propositions were picked for this conversation, the topic itself is the material.");
	}
	return lines.join("\n");
}

export type SubjectDeleteOutcome =
	| { ok: true; chatsRemoved: number }
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
	return { ok: true, chatsRemoved };
}
