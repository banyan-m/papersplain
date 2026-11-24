/**
 * papersplainer: the read-only "How the agents work" view (Michael,
 * 2026-11-24: the prompts cannot really be switched, so they do not belong
 * in Settings, but their text should be visible somewhere). One entry per
 * agent with a one-line summary and the instruction files it is built
 * from, in assembly order. Shared files are listed once, last.
 *
 * Saved overrides (written by the old Settings editor) still apply; this
 * view shows the text actually in use and marks it.
 */

import { effectivePromptSegments } from "../agent/prompt-segments.ts";
import { guideModeInstructions } from "../agent/teacher-agent.ts";
import { readSettings as readSettingsRecord } from "../store/settings.ts";

export interface AgentOverviewPart {
	/** The instruction file, e.g. "guide/20-explaining.md"; absent for text built in code. */
	path?: string;
	title: string;
	/** The text in use (the saved override when one is switched on). */
	text: string;
	overridden: boolean;
}

export interface AgentOverviewEntry {
	id: "walkthrough" | "chat" | "teacher" | "prober" | "practice" | "shared";
	name: string;
	where: string;
	summary: string;
	parts: AgentOverviewPart[];
}

const ENTRIES: readonly (Pick<AgentOverviewEntry, "id" | "name" | "where" | "summary"> & { agent: "guide" | "teacher" | "prober" | "practice" | null })[] = [
	{ id: "walkthrough", agent: "guide", name: "Walkthrough guide", where: "Papers, Walkthrough", summary: "Leads you through a paper one section or figure at a time, then stops and waits for you." },
	{ id: "chat", agent: "guide", name: "Chat guide", where: "Papers and topics, Chat", summary: "Answers what you ask, grounded in the paper. You lead." },
	{ id: "prober", agent: "prober", name: "Prober", where: "Topics, start of a Walkthrough", summary: "Asks a few questions first to find out what you already know, then hands over to the teacher." },
	{ id: "teacher", agent: "teacher", name: "Topic teacher", where: "Topics, Walkthrough", summary: "Plans the topic, teaches it step by step, and checks your understanding with questions as it goes." },
	{ id: "practice", agent: "practice", name: "Practice", where: "Papers and topics, Practice", summary: "Sets one problem at a time, grades your answer, and sums up at the end." },
	{ id: "shared", agent: null, name: "Shared rules", where: "Every agent above, in part", summary: "Voice, accuracy, formatting and question rules that several agents follow." },
];

/** The file's first Markdown heading, else its name without number and extension. */
export function partTitle(path: string, text: string): string {
	const heading = text.split("\n").find((line) => /^#{1,3}\s+\S/.test(line));
	if (heading) return heading.replace(/^#{1,3}\s+/, "").trim();
	const name = path.split("/").at(-1) ?? path;
	return name.replace(/^\d+-/, "").replace(/\.md$/, "").replace(/-/g, " ");
}

export function agentOverview(): AgentOverviewEntry[] {
	const switches = readSettingsRecord()?.agent?.prompts ?? {};
	const shared = new Map<string, AgentOverviewPart>();
	const partOf = (segment: ReturnType<typeof effectivePromptSegments>[number]): AgentOverviewPart => {
		const text = segment.enabled && segment.overrideText !== null ? segment.overrideText : segment.sourceText;
		return { path: segment.path, title: partTitle(segment.path, text), text, overridden: segment.enabled };
	};
	return ENTRIES.map(({ agent, ...entry }) => {
		if (agent === null) return { ...entry, parts: [...shared.values()] };
		const parts: AgentOverviewPart[] = [];
		for (const segment of effectivePromptSegments(agent, switches)) {
			if (segment.shared) { if (!shared.has(segment.path)) shared.set(segment.path, partOf(segment)); }
			else parts.push(partOf(segment));
		}
		if (entry.id === "walkthrough" || entry.id === "chat") {
			const text = guideModeInstructions(entry.id);
			parts.push({ title: entry.id === "chat" ? "Chat mode" : "Walkthrough mode", text, overridden: false });
		}
		return { ...entry, parts };
	});
}
