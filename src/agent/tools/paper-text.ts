import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { findSection, paperOutline, readSection, searchPaper } from "../../core/paper-document.ts";
import { chatPaperKey, paperKeyForFile, readManifest, setChatPaper } from "../subagents/paper-cache-store.ts";
import { ensurePaperDocument } from "../subagents/paper-document.ts";
import { resolvePaperOrSourcePath } from "./paper-fetch.ts";

/**
 * papersplainer: `paper`. The paper's text, converted once and kept with
 * the paper (subagents/paper-document.ts). No model runs: the first call
 * converts the PDF, every later call in any conversation on the paper
 * reads the stored text. With no `section` or `search` it returns the
 * outline: sections, figures, tables.
 */

const paperInput = Type.Object({
	path: Type.Optional(Type.String({ description: "The PDF's file path. Needed only the first time, when no conversation has read this paper yet." })),
	section: Type.Optional(Type.String({ description: "A section to read: its number from the outline, or its title." })),
	part: Type.Optional(Type.Integer({ minimum: 1, description: "For a long section returned in parts: which part." })),
	search: Type.Optional(Type.String({ description: "A word or phrase to find in the paper. Returns where it occurs." })),
});

export function createPaperTextTool(ctx: { chatId: string }): AgentTool<typeof paperInput> {
	return {
		name: "paper",
		label: "paper",
		description:
			"Read the paper's text. Instant after the first call. " +
			"Call it with nothing to get the outline (sections with numbers, figures, tables). " +
			"Call it with `section` to read one section in full, with page marks like [p. 4]. " +
			"Call it with `search` to find where a word or phrase occurs. " +
			"The first call on a new paper needs `path` and converts the PDF (up to a minute or two).",
		parameters: paperInput,
		execute: serverExecute("paper", paperInput, async ({ path: rawPath, section, part, search }, { signal }) => {
			let key = chatPaperKey(ctx.chatId);
			let pdf = key ? readManifest(key)?.source : undefined;
			if (rawPath?.trim()) {
				const given = resolvePaperOrSourcePath(rawPath.trim());
				const givenKey = await paperKeyForFile(given);
				// A session has one paper: a different PDF is read with the pdf tool.
				if (key && givenKey !== key) throw new Error("this conversation already has its paper; `paper` reads that one. Read any other PDF with the `pdf` tool.");
				pdf = given;
				if (!key) { key = givenKey; setChatPaper(ctx.chatId, key); }
			}
			if (!key || !pdf) throw new Error("no paper is known for this conversation yet: call `paper` with `path` set to the PDF's file path (use `fetch_paper` first for a link)");
			const { document, markdown, figures } = await ensurePaperDocument(pdf, key, signal);
			if (search?.trim()) {
				const hits = searchPaper(markdown, document, search);
				if (hits.length === 0) return `"${search.trim()}" does not occur in the paper's text.`;
				return hits.map((h) => `Section ${h.section} "${h.title}"${h.page ? ` (p. ${h.page})` : ""}: …${h.snippet}…`).join("\n\n");
			}
			if (section?.trim()) {
				const found = findSection(document, section);
				if (!found) throw new Error(`there is no section "${section}"; the sections are: ${document.sections.map((s) => `${s.n}. ${s.title}`).join("; ")}`);
				const read = readSection(markdown, found, part ?? 1);
				const head = `Section ${found.n}: ${found.title}${read.parts > 1 ? ` (part ${read.part} of ${read.parts}; ask for the next with part: ${Math.min(read.part + 1, read.parts)})` : ""}`;
				return `${head}\n\n${read.text}`;
			}
			return [paperOutline(document, figures), document.note].filter(Boolean).join("\n\n");
		}),
	};
}
