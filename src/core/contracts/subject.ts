/**
 * Subject contracts — papers and topics, the things a learner opens
 *
 * papersplainer (owner, 2026-11-19): the sidebar lists SUBJECTS, not
 * sessions. A subject is one paper or one topic; it owns at most one
 * conversation per mode (walkthrough, chat, practice). Each conversation is
 * still an ordinary ChatRecord with its own agent and history — the subject
 * is the layer above that ties them together and carries what they share
 * (for a paper: the per-paper cache key and where the PDF came from).
 *
 * Pure types + tiny pure helpers.
 */
import type { SubjectNotebook } from "../notebook.ts";
import { parseFilePaths } from "../file-paths.ts";
import type { ChatKind, PaperMode } from "./chat.ts";

export type SubjectKind = "paper" | "topic";

/** The three conversations a subject can hold, in display order. */
export const SUBJECT_MODES = ["walkthrough", "chat", "practice"] as const;
export type SubjectMode = (typeof SUBJECT_MODES)[number];

export function isSubjectMode(value: unknown): value is SubjectMode {
	return typeof value === "string" && (SUBJECT_MODES as readonly string[]).includes(value);
}

/** One persisted subject under data/subjects/<id>.json. */
export interface SubjectRecord {
	id: string;
	kind: SubjectKind;
	title: string;
	createdAt: string;
	/** Bumped when a conversation in the subject is created; list order uses
	 *  the newest of this and the conversations' own activity. */
	updatedAt: string;
	/** Papers: what the learner gave — a PDF path or a link. */
	source?: string;
	/** Papers: the per-paper cache key, once the PDF has been read. */
	paperKey?: string;
	/** The conversation shown for each mode (chat ids). A mode is absent until
	 *  its first message is sent. */
	chats: Partial<Record<SubjectMode, string>>;
	/** Conversations that belong to the subject but are not shown: older
	 *  sessions that lost a mode slot to a newer one during conversion. Kept
	 *  on disk, never deleted silently. */
	shelved?: string[];
	/** What the subject's conversations have established about the learner
	 *  here (core/notebook.ts). Absent until the first exchange is folded in. */
	notebook?: SubjectNotebook;
	/** Schema version; absence denotes version 1. */
	version?: number;
}

export const CURRENT_SUBJECT_VERSION = 1;

/** A subject's address, on one of its modes. */
export function subjectHref(id: string, mode: SubjectMode): string {
	return `/subject/${encodeURIComponent(id)}?mode=${mode}`;
}

/** Which agent runs a mode. A paper's walkthrough and chat are the guide in
 *  that mode. A topic's walkthrough is the teaching session (probe, plan,
 *  teach); its chat is the guide without a paper. Practice is practice. */
export function chatShapeFor(kind: SubjectKind, mode: SubjectMode): { kind: ChatKind; paperMode?: PaperMode } {
	if (mode === "practice") return { kind: "practice" };
	if (mode === "chat") return { kind: "paper", paperMode: "chat" };
	return kind === "paper" ? { kind: "paper", paperMode: "walkthrough" } : { kind: "teach" };
}

/** The mode an existing session lands in when it is filed under a subject. */
export function modeOfChat(chat: { kind?: ChatKind; paperMode?: PaperMode }): SubjectMode {
	if (chat.kind === "practice") return "practice";
	if (chat.kind === "paper") return chat.paperMode === "chat" ? "chat" : "walkthrough";
	return "walkthrough";
}

/** A link that names a paper by itself: a PDF, or a preprint/DOI page. */
const PAPER_LINK = /https?:\/\/[^\s<>"'`)\]]+/gi;
function isPaperLink(url: string): boolean {
	return /\.pdf([?#]|$)/i.test(url) || /\/\/(www\.)?(arxiv\.org\/(abs|pdf)\/|(www\.)?(biorxiv|medrxiv)\.org\/content\/|doi\.org\/|(dx\.)?doi\.org\/|pubmed\.ncbi\.nlm\.nih\.gov\/|(www\.)?ncbi\.nlm\.nih\.gov\/pmc\/|pmc\.ncbi\.nlm\.nih\.gov\/|openreview\.net\/(pdf|forum))/i.test(url);
}

/**
 * Does the New box's text name a paper? (Owner report, 2026-11-19: a PDF
 * attached with a sentence around it must still open a PAPER.) In order:
 *   - a PDF path anywhere in the text, as the path chip writes it
 *     (backtick-quoted) — the first one;
 *   - the whole text being one link, or one bare PDF path, or arxiv:ID;
 *   - a link anywhere in the text that is plainly a paper (a .pdf, arXiv,
 *     bioRxiv, medRxiv, DOI, PubMed, OpenReview).
 * Anything else is a topic.
 */
export function paperSourceOf(text: string): string | null {
	const t = text.trim();
	if (!t) return null;
	for (const part of parseFilePaths(t)) if (part.kind === "path" && /\.pdf$/i.test(part.path)) return part.path;
	if (!/\n/.test(t)) {
		if (/^https?:\/\/\S+$/i.test(t)) return t;
		if (/^arxiv:\s*\d{4}\.\d{4,5}(v\d+)?$/i.test(t)) return t;
		if (/\.pdf$/i.test(t) && /^(~\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(t)) return t;
	}
	for (const match of t.matchAll(PAPER_LINK)) {
		const url = match[0].replace(/[.,;:!?]+$/, "");
		if (isPaperLink(url)) return url;
	}
	return null;
}

/** A readable first title for a paper before anything better is known. */
export function paperTitleFromSource(source: string): string {
	const arxiv = /arxiv\.org\/(?:abs|pdf)\/([\w.\-/]+?)(?:\.pdf)?(?:[?#].*)?$/i.exec(source) ?? /^arxiv:\s*(\S+)$/i.exec(source);
	if (arxiv) return `arXiv ${arxiv[1]}`;
	const last = source.replace(/[?#].*$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? source;
	const name = last.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim();
	return name || "Untitled paper";
}

/** One sidebar row: the subject plus what its conversations are doing. */
export interface SubjectListItem {
	id: string;
	kind: SubjectKind;
	title: string;
	/** Newest activity across the subject and its shown conversations. */
	updatedAt: string;
	/** Which modes have a conversation. */
	modes: SubjectMode[];
	/** The mode touched most recently (where opening the subject lands). */
	lastMode: SubjectMode;
	/** A turn is in flight in one of its conversations. */
	busy: boolean;
	/** An unanswered teaching question is waiting. */
	pendingQuestion: boolean;
	/** A practice problem is posed but not concluded. */
	pendingProblem: boolean;
	/** Where the walkthrough is ("Section 2 of 7"), once it has recorded an
	 *  outline (papers) or tagged a plan node (topics). */
	position?: { current: number; total: number };
}
