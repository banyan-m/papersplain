/**
 * papersplainer: keeping each subject's notebook (core/notebook.ts) up to
 * date. After a turn settles, the newest part of that conversation is
 * folded in by one cheap-model call. Updates for one subject run one at a
 * time; a failed update changes nothing and the next turn retries with the
 * same messages.
 */

import { modeOfChat } from "../core/contracts/subject.ts";
import { transcriptForNotebook } from "../core/notebook.ts";
import type { PiEngine } from "../agent/models.ts";
import { runNotebookUpdate } from "../agent/subagents/notebook.ts";
import { stores } from "./stores.ts";

/** Test seam: a scripted engine for the update call. */
export const notebookModelOverride: { current?: PiEngine } = {};

const queues = new Map<string, Promise<void>>();

/** Fold one conversation's unseen messages into its subject's notebook.
 *  Resolves true when the notebook was rewritten. */
export async function updateNotebook(chatId: string, engine?: PiEngine): Promise<boolean> {
	const chat = stores.chatStore.getChat(chatId);
	const subject = chat?.subjectId ? stores.subjectStore.getSubject(chat.subjectId) : null;
	if (!chat || !subject) return false;
	const previous = subject.notebook;
	const mark = previous?.seen[chatId] ?? 0;
	// A record that shrank (compaction) no longer lines up with the mark:
	// re-read its last few messages rather than skip what follows.
	const from = mark > chat.messages.length ? Math.max(0, chat.messages.length - 4) : mark;
	if (chat.messages.length <= from) return false;
	const transcript = transcriptForNotebook(chat.messages, from);
	const seen = { ...(previous?.seen ?? {}), [chatId]: chat.messages.length };
	// Nothing worth a model call (tool chatter only): just move the mark.
	if (!transcript.trim()) {
		if (previous) stores.subjectStore.setNotebook(subject.id, { ...previous, seen });
		return false;
	}
	const next = await runNotebookUpdate(
		{ subjectTitle: subject.title, subjectKind: subject.kind, mode: modeOfChat(chat), previous, transcript, seen },
		{ engine: engine ?? notebookModelOverride.current, chatId },
	);
	if (!next) return false;
	// The subject may have changed while the model ran: keep marks set since.
	const latest = stores.subjectStore.getSubject(subject.id);
	if (!latest) return false;
	stores.subjectStore.setNotebook(subject.id, { ...next, seen: { ...(latest.notebook?.seen ?? {}), ...next.seen } });
	return true;
}

/** Start an update in the background after a turn; never throws. */
export function kickNotebook(chatId: string): void {
	const subjectId = stores.chatStore.getChat(chatId)?.subjectId;
	if (!subjectId) return;
	const run = (queues.get(subjectId) ?? Promise.resolve())
		.then(() => updateNotebook(chatId))
		.then(() => undefined, (err: unknown) => { console.error(`[notebook ${chatId}]`, err instanceof Error ? err.message : err); });
	queues.set(subjectId, run);
	void run.finally(() => { if (queues.get(subjectId) === run) queues.delete(subjectId); });
}
