import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import type { ShowImageDetails } from "../../core/contracts.ts";
import type { ChatStore } from "../../core/ports.ts";
import { chatPaperKey, figuresDir, readManifest } from "../subagents/paper-cache-store.ts";
import { loadAppImage } from "./learner-image.ts";

/**
 * papersplainer: paper_figure. Shows one of the paper's own figures in the
 * session: the figure cut out of the paper when it was converted (or, when
 * it could not be cut out, the PDF page that carries it), kept in the
 * paper's cache. Instant and model-free. The image is shown to the learner
 * only; the guide reads figures through the pdf tool.
 */

const paperFigureInput = Type.Object({
	figure: Type.Integer({ minimum: 1, description: "The figure's number as printed in the paper (Figure 3 → 3)." }),
});

export function createPaperFigureTool(ctx: { chatId: string; chatStore: Pick<ChatStore, "saveImageSnapshot"> }): AgentTool<typeof paperFigureInput> {
	return {
		name: "paper_figure",
		label: "paper_figure",
		description:
			"Show one of the paper's own figures to the learner, with its caption. Instant. " +
			"Use it whenever you explain a figure, so he sees what you are describing. You are not sent the image: " +
			"read what a figure shows (axes, panels, values) with the pdf tool. Available once `paper` has returned the outline.",
		parameters: paperFigureInput,
		execute: serverExecute("paper_figure", paperFigureInput, async ({ figure }, { signal }): Promise<ImageFileResult> => {
			const key = chatPaperKey(ctx.chatId);
			if (!key) throw new Error("no paper has been read in this session yet; call `paper` on it first");
			const figures = readManifest(key)?.figures;
			if (!figures) throw new Error("the paper's figures are still being collected; continue, and try again in a moment");
			if (figures.length === 0) throw new Error("no numbered figure captions were found in this PDF, so there are no figure pages to show");
			const found = figures.find((f) => f.number === figure);
			if (!found) throw new Error(`there is no Figure ${figure}; this paper's figures are: ${figures.map((f) => f.number).join(", ")}`);
			const image = await loadAppImage(path.join(figuresDir(key), found.file), signal);
			ctx.chatStore.saveImageSnapshot(ctx.chatId, image.snapshotId, image);
			const caption = `Figure ${found.number} (page ${found.page})${found.caption ? `: ${found.caption}` : ""}`;
			const shown = found.cropped ? "the figure itself" : `the whole of page ${found.page}, which carries it (say which part of the page to look at)`;
			const details: ShowImageDetails = {
				path: found.file,
				caption,
				mimeType: image.mimeType,
				snapshotId: image.snapshotId,
				width: image.width,
				height: image.height,
			};
			return { text: `Shown to the learner: ${shown}. ${caption}`, details };
		}),
	};
}
