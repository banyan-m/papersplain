/**
 * papersplainer: convert a paper once (Michael, 2026-11-19). The result
 * lives in the paper's cache and every conversation on the paper reads it:
 *
 *   <cache>/<key>/paper.md          the text, with `<!-- page N -->` markers
 *   <cache>/<key>/figures/…         one image per numbered figure
 *   manifest.document / .figures    the outline and the figure list
 *
 * Converter: Mistral OCR when a Mistral key is saved (the PDF is sent to
 * Mistral's API; it returns Markdown and the figures as images). Otherwise,
 * or when that call fails, the PDF's own text layer and its embedded
 * images, with no model and no network.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PaperFigure, PaperManifest } from "../../core/paper-cache.ts";
import { findFigureCaptions } from "../../core/paper-cache.ts";
import {
	cropsForPage,
	decodeImage,
	describeDocument,
	mistralToMarkdown,
	pageMark,
	type FractionBox,
	type MistralOcrPage,
	type PaperDocument,
} from "../../core/paper-document.ts";
import { getHeadless } from "./headless.ts";
import { figuresDir, paperCacheDir, readManifest, updateManifest } from "./paper-cache-store.ts";
import { pdfExtract, pdfInfo, standardFontsDir } from "./pdf-ops.ts";

const FIGURE_DPI = 150;
const MAX_FIGURES = 40;
/** Mistral's document limit is 50 MB; base64 adds a third. */
const MAX_MISTRAL_PDF_BYTES = 36 * 1024 * 1024;
const MISTRAL_TIMEOUT_MS = 180_000;

/** Wired by the server layer: the saved Mistral key, if any. */
export const paperConverterKeys: { mistral?: () => string | undefined } = {};
/** Test seam for the Mistral call. */
export const mistralFetchOverride: { current?: typeof fetch } = {};

export const paperMarkdownPath = (key: string): string => path.join(paperCacheDir(key), "paper.md");

export function readPaperMarkdown(key: string): string | null {
	try {
		return fsSync.readFileSync(paperMarkdownPath(key), "utf-8");
	} catch {
		return null;
	}
}

export interface ConvertedPaper { manifest: PaperManifest; document: PaperDocument; markdown: string; figures: PaperFigure[] }

const conversions = new Map<string, Promise<ConvertedPaper>>();

/** The paper's converted text, converting it now if this is the first time.
 *  Concurrent callers share one run. */
export function ensurePaperDocument(pdfPath: string, key: string, signal?: AbortSignal): Promise<ConvertedPaper> {
	const manifest = readManifest(key);
	const markdown = manifest?.document ? readPaperMarkdown(key) : null;
	if (manifest?.document && markdown !== null) return Promise.resolve({ manifest, document: manifest.document, markdown, figures: manifest.figures ?? [] });
	const running = conversions.get(key);
	if (running) return running;
	const run = convert(pdfPath, key, signal).finally(() => conversions.delete(key));
	conversions.set(key, run);
	return run;
}

async function convert(pdfPath: string, key: string, signal?: AbortSignal): Promise<ConvertedPaper> {
	const info = await pdfInfo(pdfPath);
	const mistralKey = paperConverterKeys.mistral?.();
	let result: { markdown: string; figures: PaperFigure[]; converter: PaperDocument["converter"] } | null = null;
	let note: string | undefined;
	await fs.rm(figuresDir(key), { recursive: true, force: true });
	await fs.mkdir(figuresDir(key), { recursive: true });
	if (mistralKey) {
		try {
			result = await convertWithMistral(pdfPath, key, mistralKey, info.page_count, signal);
		} catch (err) {
			if (signal?.aborted) throw err;
			note = `Mistral OCR failed (${err instanceof Error ? err.message : String(err)}), so the PDF's own text was used.`;
			console.error(`[paper-document ${key}]`, err);
		}
	}
	result ??= await convertFromTextLayer(pdfPath, key, info.page_count);
	const document = describeDocument(result.markdown, result.converter, info.page_count, new Date().toISOString(), note);
	await fs.writeFile(paperMarkdownPath(key), result.markdown, "utf-8");
	const figures = result.figures.sort((a, b) => a.number - b.number);
	const manifest = updateManifest(key, pdfPath, (m) => { m.document = document; m.figures = figures; });
	return { manifest, document, markdown: result.markdown, figures };
}

// ─── Mistral OCR ────────────────────────────────────────────────────────────

async function convertWithMistral(pdfPath: string, key: string, apiKey: string, pageCount: number, signal?: AbortSignal) {
	const bytes = await fs.readFile(pdfPath);
	if (bytes.length > MAX_MISTRAL_PDF_BYTES) throw new Error(`the PDF is ${(bytes.length / 1024 / 1024).toFixed(0)} MB, over the size Mistral OCR accepts`);
	const timeout = AbortSignal.timeout(MISTRAL_TIMEOUT_MS);
	const res = await (mistralFetchOverride.current ?? fetch)("https://api.mistral.ai/v1/ocr", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: "mistral-ocr-latest",
			document: { type: "document_url", document_url: `data:application/pdf;base64,${bytes.toString("base64")}` },
			include_image_base64: true,
		}),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`status ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
	}
	const body = (await res.json()) as { pages?: MistralOcrPage[] };
	if (!Array.isArray(body.pages) || body.pages.length === 0) throw new Error("the response had no pages");
	const { markdown, images, captions } = mistralToMarkdown(body.pages);
	if (markdown.replace(/<!--.*?-->/g, "").trim().length < 200) throw new Error("the response had almost no text");

	const figures: PaperFigure[] = [];
	const wholePages: typeof captions = [];
	for (const caption of captions.filter((c) => c.page >= 1 && c.page <= pageCount).slice(0, MAX_FIGURES)) {
		const image = images.find((i) => i.figure === caption.number);
		const decoded = image?.base64 ? decodeImage(image.base64) : null;
		if (!decoded) { wholePages.push(caption); continue; }
		const file = `figure-${caption.number}.${decoded.ext}`;
		await fs.writeFile(path.join(figuresDir(key), file), decoded.bytes);
		figures.push({ ...caption, file, cropped: true });
	}
	figures.push(...(await renderWholePages(pdfPath, key, wholePages)));
	return { markdown, figures, converter: "mistral" as const };
}

// ─── the fallback: the PDF's own text and embedded images ───────────────────

async function convertFromTextLayer(pdfPath: string, key: string, pageCount: number) {
	const text = await pdfExtract(pdfPath, "all");
	const parts = text.split(/^--- Page (\d+) ---$/m).slice(1);
	const pages: { page: number; text: string }[] = [];
	for (let i = 0; i < parts.length; i += 2) pages.push({ page: Number(parts[i]), text: (parts[i + 1] ?? "").trim() });
	const markdown = pages.map((p) => `${pageMark(p.page)}\n\n${p.text}`).join("\n\n");
	const captions = findFigureCaptions(pages).filter((c) => c.page >= 1 && c.page <= pageCount).slice(0, MAX_FIGURES);
	const figures: PaperFigure[] = [];
	if (captions.length > 0) {
		const wanted = [...new Set(captions.map((c) => c.page))];
		const boxes = await pageImageBoxes(pdfPath, wanted).catch(() => new Map<number, FractionBox[]>());
		const rendered = await getHeadless().renderPdfPages(pdfPath, wanted, { dpi: FIGURE_DPI });
		const byPage = new Map(rendered.map((r) => [r.page, r.png]));
		for (const page of wanted) {
			const png = byPage.get(page);
			if (!png) continue;
			const onPage = captions.filter((c) => c.page === page);
			const crops = cropsForPage(onPage.map((c) => c.number), boxes.get(page) ?? []);
			for (const caption of onPage) {
				const crop = crops.get(caption.number);
				const image = crop ? await cropPng(png, crop).catch(() => null) : null;
				const file = `figure-${caption.number}.png`;
				await fs.writeFile(path.join(figuresDir(key), file), image ?? png);
				figures.push({ ...caption, file, ...(image ? { cropped: true } : {}) });
			}
		}
	}
	return { markdown, figures, converter: "pdf-text" as const };
}

async function renderWholePages(pdfPath: string, key: string, captions: readonly { number: number; page: number; caption: string }[]): Promise<PaperFigure[]> {
	if (captions.length === 0) return [];
	const rendered = await getHeadless().renderPdfPages(pdfPath, [...new Set(captions.map((c) => c.page))], { dpi: FIGURE_DPI });
	const byPage = new Map(rendered.map((r) => [r.page, r.png]));
	const figures: PaperFigure[] = [];
	for (const caption of captions) {
		const png = byPage.get(caption.page);
		if (!png) continue;
		const file = `figure-${caption.number}.png`;
		await fs.writeFile(path.join(figuresDir(key), file), png);
		figures.push({ ...caption, file });
	}
	return figures;
}

async function cropPng(png: Buffer | Uint8Array, box: FractionBox): Promise<Buffer> {
	const { createCanvas, loadImage } = await import("@napi-rs/canvas");
	const image = await loadImage(Buffer.from(png));
	const x = Math.round(box.x0 * image.width);
	const y = Math.round(box.y0 * image.height);
	const width = Math.max(1, Math.round((box.x1 - box.x0) * image.width));
	const height = Math.max(1, Math.round((box.y1 - box.y0) * image.height));
	const canvas = createCanvas(width, height);
	canvas.getContext("2d").drawImage(image, x, y, width, height, 0, 0, width, height);
	return canvas.toBuffer("image/png");
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m1: Matrix, m2: Matrix): Matrix => [
	m1[0] * m2[0] + m1[2] * m2[1],
	m1[1] * m2[0] + m1[3] * m2[1],
	m1[0] * m2[2] + m1[2] * m2[3],
	m1[1] * m2[2] + m1[3] * m2[3],
	m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
	m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

/** Where each page's embedded images are painted, as fractions of the page.
 *  Follows the drawing transform through the page's operator list. Vector
 *  drawings have no embedded image and produce no box. */
export async function pageImageBoxes(pdfPath: string, pages: readonly number[]): Promise<Map<number, FractionBox[]>> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const data = new Uint8Array(await fs.readFile(pdfPath));
	const task = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	const doc = await task.promise;
	const out = new Map<number, FractionBox[]>();
	const { OPS } = pdfjs;
	try {
		for (const number of pages) {
			if (number < 1 || number > doc.numPages) continue;
			const page = await doc.getPage(number);
			const viewport = page.getViewport({ scale: 1 });
			const ops = await page.getOperatorList();
			let ctm = viewport.transform as Matrix;
			const stack: Matrix[] = [];
			const boxes: FractionBox[] = [];
			for (let i = 0; i < ops.fnArray.length; i++) {
				const fn = ops.fnArray[i];
				const args = ops.argsArray[i] as unknown[] | null;
				if (fn === OPS.save) stack.push(ctm);
				else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
				else if (fn === OPS.transform && args) ctm = multiply(ctm, args.slice(0, 6).map(Number) as Matrix);
				else if (fn === OPS.paintFormXObjectBegin) {
					stack.push(ctm);
					const matrix = args?.[0];
					if (matrix && (matrix as ArrayLike<number>).length === 6) ctm = multiply(ctm, Array.from(matrix as ArrayLike<number>) as Matrix);
				} else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
				else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
					// An image fills the unit square under the current transform.
					const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x! + ctm[2] * y! + ctm[4], ctm[1] * x! + ctm[3] * y! + ctm[5]]);
					const xs = corners.map((c) => c[0]! / viewport.width);
					const ys = corners.map((c) => c[1]! / viewport.height);
					boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
				}
			}
			out.set(number, boxes);
		}
	} finally {
		await task.destroy().catch(() => {});
	}
	return out;
}
