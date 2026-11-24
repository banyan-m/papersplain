/**
 * papersplainer: a paper converted once to Markdown (Michael, 2026-11-19:
 * "read each paper once"). Pure shapes and helpers: sectioning, the outline
 * an agent is shown, reading one section, searching, and turning a Mistral
 * OCR response into Markdown plus figure images.
 *
 * The Markdown carries `<!-- page N -->` markers so a passage can be cited
 * by page. Figure images are replaced in the text by a one-line marker.
 */

import { findFigureCaptions, type FigureCaption } from "./paper-cache.ts";

export type PaperConverter = "mistral" | "pdf-text";

export interface PaperSection {
	/** 1-based position in the paper. */
	n: number;
	title: string;
	level: 1 | 2 | 3;
	/** Character offsets into the Markdown: [start, end). */
	start: number;
	end: number;
	/** The page the section starts on (1-based), when known. */
	page?: number;
}

export interface PaperDocument {
	converter: PaperConverter;
	createdAt: string;
	pages: number;
	chars: number;
	sections: PaperSection[];
	/** Table labels found in the text ("Table 2"), with their opening words. */
	tables: { number: number; page?: number; caption: string }[];
	/** Why the fallback converter was used although a Mistral key exists. */
	note?: string;
}

export const PAGE_MARK = /<!-- page (\d+) -->/g;
export const pageMark = (page: number): string => `<!-- page ${page} -->`;

/** The page a character offset falls on, from the markers before it. */
export function pageAt(markdown: string, offset: number): number | undefined {
	let page: number | undefined;
	for (const m of markdown.matchAll(PAGE_MARK)) {
		if (m.index > offset) break;
		page = Number(m[1]);
	}
	return page;
}

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
/** Sections smaller than this fold into the one before (stray headings). */
const MIN_SECTION_CHARS = 200;
const MAX_SECTIONS = 60;

/** Split the Markdown at its headings. Text before the first heading is a
 *  "Front matter" section; a paper with no headings is split by page. */
export function splitSections(markdown: string): PaperSection[] {
	const raw: Omit<PaperSection, "n" | "end">[] = [];
	let offset = 0;
	let fenced = false;
	for (const line of markdown.split("\n")) {
		if (/^```/.test(line)) fenced = !fenced;
		const m = fenced ? null : HEADING.exec(line);
		if (m) {
			const title = m[2]!.replace(/[*_`]+/g, "").trim();
			if (title && title.length <= 150) raw.push({ title, level: m[1]!.length as 1 | 2 | 3, start: offset });
		}
		offset += line.length + 1;
	}
	if (raw.length === 0) {
		for (const m of markdown.matchAll(PAGE_MARK)) raw.push({ title: `Page ${m[1]}`, level: 1, start: m.index });
		if (raw.length === 0) raw.push({ title: "Text", level: 1, start: 0 });
	}
	if (raw[0]!.start > 0) {
		if (markdown.slice(0, raw[0]!.start).replace(PAGE_MARK, "").trim().length >= MIN_SECTION_CHARS) raw.unshift({ title: "Front matter", level: 1, start: 0 });
		else raw[0]!.start = 0;
	}
	// Fold stray short sections into their predecessor, then cap the count.
	const kept: typeof raw = [];
	for (let i = 0; i < raw.length; i++) {
		const end = raw[i + 1]?.start ?? markdown.length;
		if (kept.length > 0 && end - raw[i]!.start < MIN_SECTION_CHARS && kept.length >= 1 && raw[i]!.level >= kept.at(-1)!.level && i !== raw.length - 1) continue;
		kept.push(raw[i]!);
	}
	const capped = kept.length > MAX_SECTIONS ? kept.filter((s) => s.level === 1 || s.level === Math.min(...kept.map((k) => k.level))).slice(0, MAX_SECTIONS) : kept;
	const list = capped.length > 0 ? capped : kept.slice(0, MAX_SECTIONS);
	list[0]!.start = 0;
	return list.map((s, i) => ({ n: i + 1, ...s, end: list[i + 1]?.start ?? markdown.length, page: pageAt(markdown, s.start + 1) }));
}

/** Table labels at the start of a line ("Table 2." / "**Table 2:**"). */
export function findTables(markdown: string): PaperDocument["tables"] {
	const found = new Map<number, PaperDocument["tables"][number]>();
	const label = /^(?:[#>*_\s]*)(?:Table|TABLE)\s*(\d{1,3})\s*(?:[.:|]|\*\*|__|—|–|-\s)\s*(.*)$/gm;
	for (const m of markdown.matchAll(label)) {
		const number = Number(m[1]);
		if (found.has(number)) continue;
		found.set(number, { number, page: pageAt(markdown, m.index), caption: m[2]!.replace(/[*_|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) });
	}
	return [...found.values()].sort((a, b) => a.number - b.number);
}

export function describeDocument(markdown: string, converter: PaperConverter, pages: number, createdAt: string, note?: string): PaperDocument {
	return { converter, createdAt, pages, chars: markdown.length, sections: splitSections(markdown), tables: findTables(markdown), ...(note ? { note } : {}) };
}

export interface OutlineFigure { number: number; page: number; caption: string; cropped?: boolean }

/** What an agent is shown first: the paper's parts, figures and tables. */
export function paperOutline(doc: PaperDocument, figures: readonly OutlineFigure[]): string {
	const lines: string[] = [
		`The paper's text (${doc.pages} pages, ${doc.chars.toLocaleString("en-US")} characters, converted ${doc.converter === "mistral" ? "with Mistral OCR" : "from the PDF's own text layer"}).`,
		"",
		"Sections (read one with `paper`, by its number):",
		...doc.sections.map((s) => `${"  ".repeat(s.level - 1)}${s.n}. ${s.title}${s.page ? ` (p. ${s.page})` : ""}, ${(s.end - s.start).toLocaleString("en-US")} chars`),
	];
	if (figures.length > 0) {
		lines.push("", "Figures (show one with `paper_figure`, by its number):");
		for (const f of figures) lines.push(`  Figure ${f.number} (p. ${f.page})${f.cropped ? "" : ", shown as its whole page"}: ${f.caption.slice(0, 160)}`);
	} else lines.push("", "No numbered figures were found.");
	if (doc.tables.length > 0) {
		lines.push("", "Tables (they are inside the section text):");
		for (const t of doc.tables) lines.push(`  Table ${t.number}${t.page ? ` (p. ${t.page})` : ""}: ${t.caption}`);
	}
	return lines.join("\n");
}

export const SECTION_PART_CHARS = 24_000;

/** Find a section by number ("4"), or by title (case-insensitive, first match). */
export function findSection(doc: PaperDocument, ref: string): PaperSection | undefined {
	const wanted = ref.trim();
	if (/^\d+$/.test(wanted)) return doc.sections.find((s) => s.n === Number(wanted));
	const lower = wanted.toLowerCase();
	return doc.sections.find((s) => s.title.toLowerCase() === lower) ?? doc.sections.find((s) => s.title.toLowerCase().includes(lower));
}

/** One section's text, in parts when it is long. Page markers become "[p. N]". */
export function readSection(markdown: string, section: PaperSection, part = 1): { text: string; part: number; parts: number } {
	const whole = markdown.slice(section.start, section.end);
	const parts = Math.max(1, Math.ceil(whole.length / SECTION_PART_CHARS));
	const at = Math.min(Math.max(1, Math.floor(part)), parts);
	const text = whole.slice((at - 1) * SECTION_PART_CHARS, at * SECTION_PART_CHARS).replace(PAGE_MARK, "[p. $1]").trim();
	return { text, part: at, parts };
}

export interface PaperHit { section: number; title: string; page?: number; snippet: string }

/** Case-insensitive phrase search; one hit per occurrence, capped. */
export function searchPaper(markdown: string, doc: PaperDocument, query: string, max = 8): PaperHit[] {
	const needle = query.trim().toLowerCase();
	if (needle.length < 2) return [];
	const hay = markdown.toLowerCase();
	const hits: PaperHit[] = [];
	let from = 0;
	while (hits.length < max) {
		const at = hay.indexOf(needle, from);
		if (at < 0) break;
		const section = doc.sections.find((s) => at >= s.start && at < s.end);
		const snippet = markdown.slice(Math.max(0, at - 140), at + needle.length + 200).replace(PAGE_MARK, "").replace(/\s+/g, " ").trim();
		hits.push({ section: section?.n ?? 0, title: section?.title ?? "", page: pageAt(markdown, at), snippet });
		from = at + needle.length + 200;
	}
	return hits;
}

// ─── Mistral OCR ────────────────────────────────────────────────────────────

export interface MistralOcrImage {
	id: string;
	top_left_x?: number | null;
	top_left_y?: number | null;
	bottom_right_x?: number | null;
	bottom_right_y?: number | null;
	image_base64?: string | null;
}
export interface MistralOcrPage {
	index: number;
	markdown: string;
	images?: MistralOcrImage[];
}

export interface ExtractedImage {
	/** The id used in the page Markdown ("img-0.jpeg"). */
	id: string;
	page: number;
	/** The figure this image is, when a caption next to it names one. */
	figure?: number;
	area: number;
	/** "data:image/jpeg;base64,…" or bare base64, as the API returned it. */
	base64?: string;
}

const CAPTION_NEAR = /(?:^|\n)[#>*_\s]*(?:Figure|Fig\.?|FIGURE|FIG\.?)\s*(\d{1,3})\b/;

/**
 * Turn OCR pages into one Markdown text with page markers, and decide which
 * extracted image is which numbered figure: an image belongs to the figure
 * whose caption starts within a few lines after it (or, failing that, just
 * before it). When several images claim one figure the largest keeps it.
 * Image references in the text become a one-line marker.
 */
export function mistralToMarkdown(pages: readonly MistralOcrPage[]): { markdown: string; images: ExtractedImage[]; captions: FigureCaption[] } {
	const images: ExtractedImage[] = [];
	const out: string[] = [];
	const ordered = [...pages].sort((a, b) => a.index - b.index);
	for (const page of ordered) {
		const number = page.index + 1;
		let text = page.markdown ?? "";
		for (const image of page.images ?? []) {
			const ref = new RegExp(`!\\[[^\\]]*\\]\\(${image.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`);
			const at = text.search(ref);
			const width = (image.bottom_right_x ?? 0) - (image.top_left_x ?? 0);
			const height = (image.bottom_right_y ?? 0) - (image.top_left_y ?? 0);
			const entry: ExtractedImage = { id: image.id, page: number, area: Math.max(0, width) * Math.max(0, height), ...(image.image_base64 ? { base64: image.image_base64 } : {}) };
			if (at >= 0) {
				const after = CAPTION_NEAR.exec(text.slice(at, at + 700).replace(ref, ""));
				const before = after ? null : [...text.slice(Math.max(0, at - 500), at).matchAll(new RegExp(CAPTION_NEAR.source, "g"))].at(-1);
				const figure = Number((after ?? before)?.[1]);
				if (Number.isFinite(figure) && figure > 0) entry.figure = figure;
			}
			images.push(entry);
		}
		out.push(`${pageMark(number)}\n\n${text.trim()}`);
	}
	// One image per figure number: the largest wins, the rest are unnumbered.
	const best = new Map<number, ExtractedImage>();
	for (const image of images) {
		if (image.figure === undefined) continue;
		const held = best.get(image.figure);
		if (!held || image.area > held.area) best.set(image.figure, image);
	}
	for (const image of images) if (image.figure !== undefined && best.get(image.figure) !== image) delete image.figure;
	let markdown = out.join("\n\n");
	for (const image of images) {
		const ref = new RegExp(`!\\[[^\\]]*\\]\\(${image.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "g");
		markdown = markdown.replace(ref, image.figure !== undefined ? `[Figure ${image.figure} appears here]` : "[an image appears here]");
	}
	const captions = findFigureCaptions(ordered.map((p) => ({ page: p.index + 1, text: p.markdown ?? "" })));
	return { markdown, images, captions };
}

/** Split a data URL or bare base64 image into bytes and a file extension. */
export function decodeImage(base64: string): { bytes: Uint8Array; ext: "png" | "jpg" } | null {
	const m = /^data:image\/([a-z+]+);base64,(.*)$/s.exec(base64);
	const body = m ? m[2]! : base64;
	try {
		const bytes = Uint8Array.from(Buffer.from(body, "base64"));
		if (bytes.length < 32) return null;
		const png = bytes[0] === 0x89 && bytes[1] === 0x50;
		const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
		if (!png && !jpg) return null;
		return { bytes, ext: png ? "png" : "jpg" };
	} catch {
		return null;
	}
}

// ─── the fallback's figure crops ────────────────────────────────────────────

/** A box on a page in fractions of its width and height, top-left origin. */
export interface FractionBox { x0: number; y0: number; x1: number; y1: number }

const boxArea = (b: FractionBox): number => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

/**
 * Decide the crop for each figure captioned on one page from the page's
 * embedded images. One caption: the union of the page's sizeable images.
 * Several captions and as many sizeable images: one each, top to bottom.
 * Anything else (no images, as with vector plots; or an unclear match):
 * no crop, and the whole page is shown.
 */
export function cropsForPage(figureNumbers: readonly number[], boxes: readonly FractionBox[]): Map<number, FractionBox> {
	const crops = new Map<number, FractionBox>();
	const sizeable = boxes
		.map((b) => ({ x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(1, b.x1), y1: Math.min(1, b.y1) }))
		.filter((b) => boxArea(b) >= 0.015);
	if (sizeable.length === 0 || figureNumbers.length === 0) return crops;
	const pad = (b: FractionBox): FractionBox => ({ x0: Math.max(0, b.x0 - 0.015), y0: Math.max(0, b.y0 - 0.015), x1: Math.min(1, b.x1 + 0.015), y1: Math.min(1, b.y1 + 0.015) });
	if (figureNumbers.length === 1) {
		const union = sizeable.reduce((u, b) => ({ x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }));
		if (boxArea(union) < 0.85) crops.set(figureNumbers[0]!, pad(union));
	} else if (sizeable.length === figureNumbers.length) {
		const top = [...sizeable].sort((a, b) => a.y0 - b.y0);
		figureNumbers.forEach((n, i) => crops.set(n, pad(top[i]!)));
	}
	return crops;
}
