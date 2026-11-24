/**
 * papersplainer: one cheap-model call that rewrites a subject's notebook
 * from the newest part of a conversation (core/notebook.ts). Background
 * work on the cheap slot, like the per-paper formula pass.
 */

import { randomUUID } from "node:crypto";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { notebookText, screenNotebook, type SubjectNotebook } from "../../core/notebook.ts";
import { backgroundCaptureStream, createBackgroundCapture } from "../background-capture.ts";
import { piEngineFor, type PiEngine } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
import { workerRequestStream } from "../worker-request-admission.ts";
import { extractJsonObject } from "./paper-formulas.ts";
import { streamOnce } from "./visual-maker.ts";

const INSTRUCTIONS = [
	"You keep a short notebook about one learner studying one paper or topic. Several tutoring agents share it: a walkthrough, a free chat, a practice session. Each sees only its own conversation, so the notebook is how they know what happened in the others.",
	"",
	"You are given the notebook as it stands and the newest part of one conversation. Return the WHOLE updated notebook as one JSON object and nothing else:",
	"",
	'{"covered": [...], "solid": [...], "shaky": [...], "asked": [...], "next": "..."}',
	"",
	"- covered: what has been gone through, in order, one short line each (\"Figure 2: ablations\", \"The loss function\"). Add; never drop.",
	"- solid: what the learner has SHOWN he understands: he answered correctly, explained it back, or used it correctly. The agent explaining something is not evidence. One line each, saying what and how you know.",
	"- shaky: what he got wrong, was confused by, or asked to have repeated, with the specific mistake when there is one. Move an item to solid only when he later shows it; then remove it here.",
	"- asked: what he asked about or said he wants (a pace, a depth, a direction, a topic to return to).",
	"- next: one line on where to pick up.",
	"",
	"Rules: only what the conversation shows. No praise, no guesses about ability, nothing about the learner as a person. Each line under 30 words. Merge duplicates. If the new part adds nothing, return the notebook unchanged.",
].join("\n");

export interface NotebookUpdateInput {
	subjectTitle: string;
	subjectKind: "paper" | "topic";
	mode: string;
	previous: SubjectNotebook | undefined;
	transcript: string;
	/** The `seen` map the new notebook should carry. */
	seen: Record<string, number>;
}

export interface NotebookUpdateOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	chatId?: string;
	onUsage?: (usage: Usage) => void;
}

/** Throws on provider failure; resolves null when the reply is unusable. */
export async function runNotebookUpdate(input: NotebookUpdateInput, opts: NotebookUpdateOptions = {}): Promise<SubjectNotebook | null> {
	const engine = opts.engine ?? piEngineFor("demoBuilder");
	const sessionId = randomUUID();
	const capture = createBackgroundCapture({ role: "demoBuilder", runId: sessionId, sourceId: opts.chatId });
	const streamEngine = { ...engine, streamFn: backgroundCaptureStream(workerRequestStream(engine.streamFn), capture) };
	const messages: Message[] = [{
		role: "user",
		content: [
			`The ${input.subjectKind}: "${input.subjectTitle}".`,
			"",
			"The notebook as it stands:",
			notebookText(input.previous) || "(empty)",
			"",
			`The newest part of the ${input.mode} conversation:`,
			"",
			input.transcript,
		].join("\n"),
		timestamp: Date.now(),
	}];
	const reply = await streamOnce(streamEngine, INSTRUCTIONS, messages, [], sessionId, engine.level, opts.abortSignal, opts.chatId ? providerEventObserver(opts.chatId, "job:demoBuilder") : undefined, capture);
	opts.onUsage?.(reply.usage);
	const text = reply.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("");
	return screenNotebook(extractJsonObject(text), input.seen, new Date().toISOString());
}
