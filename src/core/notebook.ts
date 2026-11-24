/**
 * papersplainer: the subject notebook (Michael, 2026-11-19: "a shared state
 * … like a supervisor agent that has a compressed version of all three
 * chats … the basis by which we can measure the user's understanding").
 *
 * One compact record per paper or topic. A cheap model rewrites it after
 * each exchange from what was just said; every agent on the subject is
 * given it, and the Progress view shows it. Pure shapes, the screening of
 * the model's reply, and the texts built from it.
 */

import type { LhMessage } from "./native-messages.ts";

export interface SubjectNotebook {
	updatedAt: string;
	/** What has been gone through, in order. */
	covered: string[];
	/** What he has shown he understands (answered right, explained back, used correctly). */
	solid: string[];
	/** What he got wrong, was confused by, or has not shown yet. */
	shaky: string[];
	/** What he asked about or said he wants. */
	asked: string[];
	/** Where to pick up next, in one line. */
	next?: string;
	/** How many messages of each conversation are already folded in. */
	seen: Record<string, number>;
}

export const NOTEBOOK_LIMITS = { covered: 14, solid: 10, shaky: 10, asked: 10, itemChars: 220 } as const;
type ListKey = "covered" | "solid" | "shaky" | "asked";
const LISTS: readonly ListKey[] = ["covered", "solid", "shaky", "asked"];

function cleanList(value: unknown, max: number): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const text = item.replace(/\s+/g, " ").trim().slice(0, NOTEBOOK_LIMITS.itemChars);
		const key = text.toLowerCase();
		if (!text || seen.has(key)) continue;
		seen.add(key);
		out.push(text);
	}
	// Newest entries are last; when over the cap, the oldest go.
	return out.slice(-max);
}

/** Keep what is usable from the model's reply. Null when the reply holds
 *  nothing (the previous notebook then stands). */
export function screenNotebook(reply: unknown, seen: Record<string, number>, now: string): SubjectNotebook | null {
	if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return null;
	const r = reply as Record<string, unknown>;
	const lists = Object.fromEntries(LISTS.map((k) => [k, cleanList(r[k], NOTEBOOK_LIMITS[k])])) as Record<ListKey, string[]>;
	const next = typeof r.next === "string" ? r.next.replace(/\s+/g, " ").trim().slice(0, NOTEBOOK_LIMITS.itemChars) : "";
	if (LISTS.every((k) => lists[k].length === 0) && !next) return null;
	return { updatedAt: now, ...lists, ...(next ? { next } : {}), seen };
}

export function isNotebookEmpty(notebook: SubjectNotebook | undefined | null): boolean {
	return !notebook || (LISTS.every((k) => notebook[k].length === 0) && !notebook.next);
}

const HEADINGS: Record<ListKey, string> = {
	covered: "Covered so far",
	solid: "He has shown he understands",
	shaky: "Shaky, wrong or not yet shown",
	asked: "He asked about or wants",
};

/** The notebook as the lines an agent is given. Empty string when empty. */
export function notebookText(notebook: SubjectNotebook | undefined | null): string {
	if (isNotebookEmpty(notebook)) return "";
	const lines: string[] = [];
	for (const key of LISTS) {
		if (notebook![key].length === 0) continue;
		lines.push(`${HEADINGS[key]}:`, ...notebook![key].map((item) => `- ${item}`));
	}
	if (notebook!.next) lines.push(`Where to pick up: ${notebook!.next}`);
	return lines.join("\n");
}

const MAX_TEXT = 1200;
const clip = (s: string, max = MAX_TEXT): string => (s.length > max ? `${s.slice(0, max)} […]` : s);
/** Tool calls whose arguments say something about the learner or the material. */
const TELLING_CALLS = new Set(["section", "outline", "problem", "conclude", "quiz", "explain", "ask_user_question", "probe_done", "formula", "derivation", "paper_figure"]);
/** Tool results that carry his answer or a verdict on it. */
const TELLING_RESULTS = new Set(["problem", "conclude", "quiz", "explain", "ask_user_question", "probe_done"]);

/** The new part of a conversation as plain lines for the notebook model:
 *  what he wrote, what the agent said, and the calls and results that bear
 *  on what was covered and how he did. Tool chatter is left out. */
export function transcriptForNotebook(messages: readonly LhMessage[], from: number): string {
	const lines: string[] = [];
	for (const message of messages.slice(from)) {
		const m = message as { role?: string; content?: unknown; toolName?: string; isError?: boolean };
		const blocks = Array.isArray(m.content) ? (m.content as { type?: string; text?: string; name?: string; arguments?: unknown }[]) : [];
		const text = typeof m.content === "string" ? m.content : blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
		if (m.role === "user" && text) lines.push(`LEARNER: ${clip(text)}`);
		else if (m.role === "assistant") {
			if (text) lines.push(`AGENT: ${clip(text)}`);
			for (const b of blocks) {
				if (b.type === "toolCall" && typeof b.name === "string" && TELLING_CALLS.has(b.name)) lines.push(`AGENT showed (${b.name}): ${clip(JSON.stringify(b.arguments ?? {}), 900)}`);
			}
		} else if (m.role === "toolResult" && !m.isError && typeof m.toolName === "string" && TELLING_RESULTS.has(m.toolName) && text) {
			lines.push(`RESULT (${m.toolName}): ${clip(text, 900)}`);
		}
	}
	return lines.join("\n\n");
}
