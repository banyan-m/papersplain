/**
 * papersplainer: the per-paper cache's shapes and pure helpers.
 *
 * A paper's cache holds material every session on that paper can reuse:
 * the pages that carry its figures (rendered from the PDF, with captions)
 * and a small toy dataset in the study's own file formats. The cache is
 * keyed by the PDF's content, so two sessions on the same file share it.
 */

import type { FormulaCardInput } from "./formula.ts";
import type { PaperDocument } from "./paper-document.ts";

export interface PaperFigure {
	/** The figure's number as printed ("Figure 3" → 3). */
	number: number;
	/** 1-based PDF page carrying the caption. */
	page: number;
	/** The caption's opening text. */
	caption: string;
	/** The image, under the cache's figures folder: the figure itself when
	 *  `cropped`, otherwise a PNG of the whole page. */
	file: string;
	cropped?: boolean;
}

export interface ToyDataFile {
	name: string;
	/** Format family the checker recognised ("fastq", "vcf", "bam", "hdf5", …) or "unchecked". */
	format: string;
	bytes: number;
	/** True when the file was parsed back and passed its format's checks. */
	checked: boolean;
	/** What the checker counted ("8 records", "3 samples × 20 genes"). */
	summary: string;
	/** The file's opening lines (text), or a listing of its contents (binary). */
	preview: string;
}

export interface ToyData {
	title: string;
	files: ToyDataFile[];
	/** The maker's notes: what each file stands for in the study. */
	notes?: string;
	createdAt: string;
}

export interface PaperManifest {
	key: string;
	/** Where the PDF was read from when the cache was created. */
	source: string;
	createdAt: string;
	/** Absent until figure extraction has run; empty when it found none. */
	figures?: PaperFigure[];
	toy?: ToyData;
	/** Absent until the formula pass has run for this paper. */
	formulas?: PaperFormulas;
	/** Absent until the paper has been converted to Markdown (paper.md beside
	 *  this manifest). core/paper-document.ts. */
	document?: PaperDocument;
}

/** Formula cards prepared for one paper (agent/subagents/paper-formulas.ts):
 *  the library cards it uses, and cards for its own equations by name. */
export interface PaperFormulas {
	library: string[];
	cards: Record<string, FormulaCardInput>;
	createdAt: string;
}

/** "name: title; …" for a paper's own prepared cards. */
export function paperFormulaIndex(formulas: PaperFormulas | undefined): string {
	return formulas ? Object.entries(formulas.cards).map(([name, card]) => `${name}: ${card.title}`).join("; ") : "";
}

/** A safe cache file name: one path segment, no leading dot. */
export function isCacheFileName(name: string): boolean {
	return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(name) && !name.includes("..");
}

/** A cache key: the PDF's content hash prefix, or a session-scoped fallback. */
export function isPaperKey(key: string): boolean {
	return /^[a-f0-9]{16}$/.test(key) || /^chat-[A-Za-z0-9_-]{1,80}$/.test(key);
}

export interface FigureCaption {
	number: number;
	page: number;
	caption: string;
}

/**
 * Find figure captions in a paper's page texts. A caption is a line that
 * STARTS with "Figure N" / "Fig. N" followed by a separator (".", ":", "|")
 * or the end of the label; in-text references ("as shown in Figure 2")
 * do not start a line and are skipped. The first caption for each number
 * wins. Supplementary figures ("Figure S1") are not included.
 */
export function findFigureCaptions(pages: readonly { page: number; text: string }[]): FigureCaption[] {
	const found = new Map<number, FigureCaption>();
	const start = /^(?:[#>*_\s]*)(?:Figure|Fig\.?|FIGURE|FIG\.?)\s*(\d{1,3})\s*(?:[.:|]|\*\*|__|—|–|-\s)\s*(.*)$/;
	// Any new figure or table label (numbered or supplementary) ends a wrapped caption.
	const nextLabel = /^(?:[#>*_\s]*)(?:Figure|Fig\.?|Table|FIGURE|FIG\.?|TABLE)\s*S?\d/;
	for (const { page, text } of pages) {
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const m = start.exec(lines[i]!.trim());
			if (!m) continue;
			const number = Number(m[1]);
			if (found.has(number)) continue;
			// A caption often wraps: take following non-empty lines up to a blank one.
			let caption = m[2]!.replace(/[*_]+/g, "").trim();
			for (let j = i + 1; j < lines.length && caption.length < 400; j++) {
				const next = lines[j]!.trim();
				if (!next || nextLabel.test(next)) break;
				caption += ` ${next}`;
			}
			caption = caption.replace(/\s+/g, " ").trim();
			found.set(number, { number, page, caption: caption.length > 400 ? `${caption.slice(0, 397)}…` : caption });
		}
	}
	return [...found.values()].sort((a, b) => a.number - b.number);
}

const CONTEXT_BUDGET = 6000;

/** The text handed to visual makers so they can use the paper's toy data:
 *  each file's name, format and opening lines. Empty when there is none. */
export function toyDataContext(toy: ToyData | undefined, where?: string): string {
	if (!toy || toy.files.length === 0) return "";
	const parts = [
		"Example data for this paper (a small toy dataset in the study's own file formats; values are illustrative, not the study's real data):",
	];
	let used = parts[0]!.length;
	for (const file of toy.files) {
		const head = `\n### ${file.name} (${file.format}; ${file.summary})`;
		const room = CONTEXT_BUDGET - used - head.length;
		if (room < 200) {
			parts.push(`\n(${toy.files.length - (parts.length - 1)} more file(s) not shown.)`);
			break;
		}
		const preview = file.preview.length > room ? `${file.preview.slice(0, room)}\n…` : file.preview;
		parts.push(`${head}\n${preview}`);
		used += head.length + preview.length;
	}
	if (where) parts.push(`\n${where}`);
	return parts.join("\n");
}
