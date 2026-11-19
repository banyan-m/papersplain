/**
 * Subject progress — what the Progress view shows for one paper or topic.
 *
 * papersplainer (owner, 2026-11-19): the first version is built ONLY from
 * what the conversations already recorded — no model call, no assessment of
 * understanding. Everything here is a pure fold over native transcripts:
 *
 *   - a paper walkthrough's sections, from its most recent clean `outline`
 *     call (agent/tools/outline.ts);
 *   - a topic walkthrough's plan, from the session plan tree and the
 *     positions its quiz calls tag (contracts/plan.ts);
 *   - practice results, from clean `problem` / `conclude` calls.
 *
 * Calls count only through their results (the honest-activation rule): an
 * errored or dangling call records nothing.
 */
import type { LhMessage } from "./native-messages.ts";
import { derivePlanStatusesLh, derivedNodeStatus, type PlanNodeStatus, type PlanTree } from "./contracts/plan.ts";

/** What a clean `outline` call records. */
export interface OutlineDetails {
	sections: string[];
	/** 1-based. */
	current: number;
}

export type StepState = "done" | "current" | "upcoming";

export interface ProgressStep {
	title: string;
	state: StepState;
	/** Topic plans only: what the step covers. */
	summary?: string;
}

export const PRACTICE_OUTCOMES = ["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"] as const;
export type PracticeOutcome = (typeof PRACTICE_OUTCOMES)[number];

export interface PracticeResults {
	/** Problems posed (clean poses). */
	posed: number;
	/** Concluded problems by outcome. */
	outcomes: Record<PracticeOutcome, number>;
	/** A problem is posed and not yet concluded. */
	active: boolean;
	/** Most recent first: the statement's first line and how it ended. */
	recent: { statement: string; outcome: PracticeOutcome | null }[];
}

export interface SubjectProgress {
	/** Null until the walkthrough has recorded an outline or a plan. */
	steps: ProgressStep[] | null;
	/** Null until a practice conversation exists. */
	practice: PracticeResults | null;
	/** What came up in this subject's conversations (from the map). */
	concepts: { id: string; name: string; statement: string }[];
}

interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> }

function toolCalls(message: LhMessage): ToolCallBlock[] {
	const m = message as { role?: string; content?: unknown };
	if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
	return m.content.filter((b): b is ToolCallBlock => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "toolCall");
}

/** Ids of calls whose result arrived without error. */
function cleanResultIds(messages: readonly LhMessage[], toolName: string): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		const m = message as { role?: string; toolName?: string; toolCallId?: string; isError?: boolean };
		if (m.role === "toolResult" && m.toolName === toolName && !m.isError && typeof m.toolCallId === "string") ids.add(m.toolCallId);
	}
	return ids;
}

function isOutline(value: unknown): value is OutlineDetails {
	const v = value as Partial<OutlineDetails> | null;
	return !!v && Array.isArray(v.sections) && v.sections.length > 0 && v.sections.every((s) => typeof s === "string")
		&& typeof v.current === "number" && Number.isInteger(v.current) && v.current >= 1 && v.current <= v.sections.length;
}

/** The walkthrough's outline as last recorded, or null. */
export function outlineOf(messages: readonly LhMessage[]): OutlineDetails | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; toolName?: string; isError?: boolean; details?: unknown };
		if (m.role === "toolResult" && m.toolName === "outline" && !m.isError && isOutline(m.details)) return m.details;
	}
	return null;
}

export function outlineSteps(outline: OutlineDetails): ProgressStep[] {
	return outline.sections.map((title, i) => ({ title, state: i + 1 < outline.current ? "done" : i + 1 === outline.current ? "current" : "upcoming" }));
}

const STEP_OF: Record<PlanNodeStatus, StepState> = { visited: "done", current: "current", upcoming: "upcoming" };

/** A teaching session's plan as steps, in the plan's own node order. */
export function planSteps(tree: PlanTree, messages: readonly LhMessage[]): ProgressStep[] {
	const statuses = derivePlanStatusesLh(tree, messages);
	return tree.nodes.map((node) => ({
		title: node.title,
		state: STEP_OF[derivedNodeStatus(statuses, node.id)],
		...(node.summary ? { summary: node.summary } : {}),
	}));
}

function firstLine(text: unknown): string {
	const line = typeof text === "string" ? text.trim().split("\n").find((l) => l.trim() !== "") ?? "" : "";
	return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

export function practiceResults(messages: readonly LhMessage[]): PracticeResults {
	const posedIds = cleanResultIds(messages, "problem");
	const concludedIds = cleanResultIds(messages, "conclude");
	const outcomes = Object.fromEntries(PRACTICE_OUTCOMES.map((o) => [o, 0])) as Record<PracticeOutcome, number>;
	const problems: { statement: string; outcome: PracticeOutcome | null }[] = [];
	for (const message of messages) {
		for (const call of toolCalls(message)) {
			if (call.name === "problem" && posedIds.has(call.id)) {
				problems.push({ statement: firstLine(call.arguments?.statement), outcome: null });
			} else if (call.name === "conclude" && concludedIds.has(call.id)) {
				const outcome = call.arguments?.outcome;
				if (!(PRACTICE_OUTCOMES as readonly unknown[]).includes(outcome)) continue;
				outcomes[outcome as PracticeOutcome]++;
				// A conclude ends the one active problem: the latest pose still open.
				const open = problems.findLast((p) => p.outcome === null);
				if (open) open.outcome = outcome as PracticeOutcome;
			}
		}
	}
	return { posed: problems.length, outcomes, active: problems.at(-1)?.outcome === null && problems.length > 0, recent: problems.reverse().slice(0, 8) };
}

/** "Section 2 of 7" for a row or a header; null when nothing is recorded. */
export function stepPosition(steps: readonly ProgressStep[] | null): { current: number; total: number } | null {
	if (!steps || steps.length === 0) return null;
	const at = steps.findIndex((s) => s.state === "current");
	if (at >= 0) return { current: at + 1, total: steps.length };
	const done = steps.filter((s) => s.state === "done").length;
	return done > 0 ? { current: done, total: steps.length } : null;
}
