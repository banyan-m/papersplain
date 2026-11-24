import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ChatStore } from "../../core/ports.ts";
import { MAX_POINT_WORDS, MAX_SECTION_POINTS, MAX_TAKEAWAY_WORDS, normalizeSectionCard, SECTION_TONES, type SectionCardDetails } from "../../core/section-card.ts";
import { loadPaperFigure } from "./paper-figure.ts";

/**
 * papersplainer: `section`. One section of the paper laid out as a reading
 * spread instead of paragraphs: the paper's own figure first, a few short
 * colour-coded points, one takeaway. Instant and model-free; the figure
 * comes from the paper's cache.
 */

const sectionInput = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 120, description: "The section's title, in plain words (\"How reads become counts\")." }),
	kicker: Type.Optional(Type.String({ maxLength: 60, description: "Where this is in the paper: \"Methods · p. 4\", \"Figure 2 · p. 6\"." })),
	figure: Type.Optional(Type.Integer({ minimum: 1, description: "The number of the paper's figure this section is about. It is shown at the top. Leave out only when the section has no figure." })),
	layout: Type.Optional(Type.Union([Type.Literal("stack"), Type.Literal("side")], {
		description: "\"stack\" (default): figure on top, points below. \"side\": the figure stays pinned beside the points; use it when the points walk through a multi-panel figure, one point per panel.",
	})),
	points: Type.Array(
		Type.Object({
			label: Type.String({ minLength: 1, maxLength: 40, description: "Two or three words: \"The input\", \"Panel b\", \"The catch\"." }),
			text: Type.String({ minLength: 1, description: `What to understand, in at most ${MAX_POINT_WORDS} words. Markdown and $math$ are allowed. Cite the page.` }),
			tone: Type.Optional(Type.Union(SECTION_TONES.map((t) => Type.Literal(t)), { description: "The point's colour. Leave out to get a different colour per point. Reuse one colour for points about the same thing." })),
		}),
		{ minItems: 1, maxItems: MAX_SECTION_POINTS, description: "Two to four points, each one idea." },
	),
	takeaway: Type.String({ minLength: 1, description: `The one thing to remember from this section: one sentence, at most ${MAX_TAKEAWAY_WORDS} words.` }),
});

export function createSectionTool(ctx: { chatId: string; chatStore: Pick<ChatStore, "saveImageSnapshot"> }): AgentTool<typeof sectionInput> {
	return {
		name: "section",
		label: "section",
		description:
			"Present one section of the paper to the learner as a card: the paper's figure on top, two to four short colour-coded points, one takeaway. Instant. " +
			"This is how you explain a section: the card carries the explanation, so do not repeat it in prose afterwards. " +
			"Read the section with `paper` first; what a figure shows comes from `pdf`.",
		parameters: sectionInput,
		execute: serverExecute("section", sectionInput, async (input, { signal }): Promise<{ text: string; details: SectionCardDetails }> => {
			const card = normalizeSectionCard(input);
			let details: SectionCardDetails = card;
			let shown = "no figure";
			if (input.figure !== undefined) {
				const { found, image } = await loadPaperFigure(ctx, input.figure, signal);
				details = {
					...card,
					figure: {
						number: found.number,
						cropped: found.cropped === true,
						path: found.file,
						caption: `Figure ${found.number}${found.caption ? `. ${found.caption}` : ""}`,
						mimeType: image.mimeType,
						snapshotId: image.snapshotId,
						width: image.width,
						height: image.height,
					},
				};
				shown = found.cropped ? `Figure ${found.number}` : `page ${found.page}, which carries Figure ${found.number} (the whole page is shown: one of your points should say where on it to look)`;
			}
			return { text: `Shown to the learner as a section card: "${card.title}", ${card.points.length} point${card.points.length === 1 ? "" : "s"}, with ${shown}. Do not restate it. Add at most one line, then stop and wait.`, details };
		}),
	};
}
