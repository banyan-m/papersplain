/**
 * papersplainer: the section card (Michael, 2026-11-19: the walkthrough was
 * "way too text driven"; 2026-11-24: layout A, with C for big figures).
 * One section of a paper as a reading spread: the paper's figure first, a
 * few short colour-coded points, one takeaway. Pure shapes and the
 * normalizer shared by the tool and the card.
 */

import type { ShowImageDetails } from "./contracts/chat.ts";

export const SECTION_TONES = ["blue", "green", "amber", "rose", "violet"] as const;
export type SectionTone = (typeof SECTION_TONES)[number];
/** "stack": figure above the points (layout A). "side": figure pinned
 *  beside them while they scroll (layout C, for multi-panel figures). */
export type SectionLayout = "stack" | "side";

export const MAX_SECTION_POINTS = 5;
export const MAX_POINT_WORDS = 70;
export const MAX_TAKEAWAY_WORDS = 45;

export interface SectionPoint {
	/** Two or three words naming the point ("The input", "Panel b"). */
	label: string;
	text: string;
	tone: SectionTone;
}

export interface SectionCardDetails {
	title: string;
	/** Small line above the title: where in the paper ("Methods · p. 4"). */
	kicker?: string;
	layout: SectionLayout;
	/** The paper's figure shown with the section, when one was asked for. */
	figure?: ShowImageDetails & { number: number; cropped: boolean };
	points: SectionPoint[];
	takeaway: string;
}

export interface SectionCardInput {
	title: string;
	kicker?: string;
	figure?: number;
	layout?: SectionLayout;
	points: { label: string; text: string; tone?: SectionTone }[];
	takeaway: string;
}

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** Clean the tool's input; throws with a message the model can act on. */
export function normalizeSectionCard(input: SectionCardInput): Omit<SectionCardDetails, "figure"> {
	const title = input.title.trim();
	if (!title) throw new Error("title is empty");
	const points = input.points
		.map((p) => ({ label: p.label.trim(), text: p.text.trim(), tone: p.tone }))
		.filter((p) => p.label !== "" && p.text !== "");
	if (points.length === 0) throw new Error("give at least one point with a label and text");
	if (points.length > MAX_SECTION_POINTS) throw new Error(`at most ${MAX_SECTION_POINTS} points: a section with more is two sections`);
	for (const p of points) {
		if (words(p.label) > 5) throw new Error(`the label "${p.label}" is too long: two or three words`);
		if (words(p.text) > MAX_POINT_WORDS) throw new Error(`the point "${p.label}" has ${words(p.text)} words; the limit is ${MAX_POINT_WORDS}. Cut it, or split the section.`);
	}
	const takeaway = input.takeaway.trim();
	if (!takeaway) throw new Error("takeaway is empty");
	if (words(takeaway) > MAX_TAKEAWAY_WORDS) throw new Error(`the takeaway has ${words(takeaway)} words; the limit is ${MAX_TAKEAWAY_WORDS}. One sentence.`);
	const kicker = input.kicker?.trim();
	return {
		title,
		...(kicker ? { kicker } : {}),
		layout: input.layout === "side" && input.figure !== undefined ? "side" : "stack",
		// Each point gets its own colour unless the guide chose one.
		points: points.map((p, i) => ({ label: p.label, text: p.text, tone: p.tone ?? SECTION_TONES[i % SECTION_TONES.length]! })),
		takeaway,
	};
}

export function isSectionCardDetails(value: unknown): value is SectionCardDetails {
	const v = value as Partial<SectionCardDetails> | null | undefined;
	return Boolean(v) && typeof v!.title === "string" && typeof v!.takeaway === "string" && Array.isArray(v!.points)
		&& v!.points.every((p) => p && typeof p.label === "string" && typeof p.text === "string" && (SECTION_TONES as readonly string[]).includes(p.tone));
}
