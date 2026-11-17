import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";
import { findFigureCaptions, isPaperKey, type PaperFigure, type PaperManifest, type ToyData } from "../../core/paper-cache.ts";
import { getHeadless } from "./headless.ts";
import { pdfExtract, pdfInfo } from "./pdf-ops.ts";

/**
 * papersplainer: the per-paper cache on disk.
 *
 *   <data>/paper-cache/<key>/manifest.json
 *   <data>/paper-cache/<key>/figures/figure-<n>.png   (the page carrying figure n)
 *   <data>/paper-cache/<key>/toy/<file>               (the toy dataset)
 *   <data>/paper-cache/sessions/<chatId>.json         (which paper a session is on)
 *
 * <key> is the first 16 hex digits of the PDF's SHA-256, so sessions on the
 * same file share one cache. A session that has not read a PDF yet uses a
 * private "chat-<id>" key.
 */

const SESSIONS = path.join(PATHS.paperCache, "sessions");

export function paperCacheDir(key: string): string {
	if (!isPaperKey(key)) throw new Error("invalid paper key");
	return path.join(PATHS.paperCache, key);
}
export const figuresDir = (key: string): string => path.join(paperCacheDir(key), "figures");
export const toyDir = (key: string): string => path.join(paperCacheDir(key), "toy");

export async function paperKeyForFile(pdfPath: string): Promise<string> {
	const hash = createHash("sha256");
	hash.update(await fs.readFile(pdfPath));
	return hash.digest("hex").slice(0, 16);
}

function sessionFile(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error("invalid chat id");
	return path.join(SESSIONS, `${chatId}.json`);
}

/** The paper a session is on, or null when it has not read a PDF yet. */
export function chatPaperKey(chatId: string): string | null {
	try {
		const key = (JSON.parse(fsSync.readFileSync(sessionFile(chatId), "utf-8")) as { key?: unknown }).key;
		return typeof key === "string" && isPaperKey(key) ? key : null;
	} catch {
		return null;
	}
}

/** The cache a session reads and writes: its paper's, else a private one. */
export function chatCacheKey(chatId: string): string {
	return chatPaperKey(chatId) ?? `chat-${chatId}`;
}

export function setChatPaper(chatId: string, key: string): void {
	fsSync.mkdirSync(SESSIONS, { recursive: true });
	fsSync.writeFileSync(sessionFile(chatId), JSON.stringify({ key }));
}

/** Forget a deleted session: its link, and its private cache if it had one. */
export function forgetChatPaper(chatId: string): void {
	try {
		fsSync.rmSync(sessionFile(chatId), { force: true });
		fsSync.rmSync(paperCacheDir(`chat-${chatId}`), { recursive: true, force: true });
	} catch { /* leftovers are harmless */ }
}

export function readManifest(key: string): PaperManifest | null {
	try {
		return JSON.parse(fsSync.readFileSync(path.join(paperCacheDir(key), "manifest.json"), "utf-8")) as PaperManifest;
	} catch {
		return null;
	}
}

function writeManifest(manifest: PaperManifest): void {
	const dir = paperCacheDir(manifest.key);
	fsSync.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `manifest.json.${process.pid}.tmp`);
	fsSync.writeFileSync(tmp, JSON.stringify(manifest, null, "\t"));
	fsSync.renameSync(tmp, path.join(dir, "manifest.json"));
}

/** Read-modify-write the manifest, creating it when absent. */
export function updateManifest(key: string, source: string, change: (manifest: PaperManifest) => void): PaperManifest {
	const manifest = readManifest(key) ?? { key, source, createdAt: new Date().toISOString() };
	change(manifest);
	writeManifest(manifest);
	return manifest;
}

/** The session's toy data, if any has been made for its paper. */
export function chatToyData(chatId: string): ToyData | undefined {
	return readManifest(chatCacheKey(chatId))?.toy;
}

const FIGURE_DPI = 130;
const MAX_FIGURES = 40;
const extractions = new Map<string, Promise<PaperFigure[]>>();

/**
 * Find the paper's figure captions and render the page each sits on.
 * Runs once per paper (the manifest remembers the result, including "none
 * found"); concurrent callers share one run. Whole pages are saved, not
 * cropped figures: a caption tells us which page, not where the figure's
 * edges are.
 */
export function ensurePaperFigures(pdfPath: string, key: string): Promise<PaperFigure[]> {
	const known = readManifest(key)?.figures;
	if (known) return Promise.resolve(known);
	const running = extractions.get(key);
	if (running) return running;
	const run = extractFigures(pdfPath, key).finally(() => extractions.delete(key));
	extractions.set(key, run);
	return run;
}

async function extractFigures(pdfPath: string, key: string): Promise<PaperFigure[]> {
	const info = await pdfInfo(pdfPath);
	const text = await pdfExtract(pdfPath, "all");
	const pages = text
		.split(/^--- Page (\d+) ---$/m)
		.slice(1)
		.reduce<{ page: number; text: string }[]>((acc, part, i, all) => {
			if (i % 2 === 0) acc.push({ page: Number(part), text: all[i + 1] ?? "" });
			return acc;
		}, []);
	const captions = findFigureCaptions(pages).filter((c) => c.page >= 1 && c.page <= info.page_count).slice(0, MAX_FIGURES);
	const figures: PaperFigure[] = [];
	if (captions.length > 0) {
		const wanted = [...new Set(captions.map((c) => c.page))];
		const rendered = await getHeadless().renderPdfPages(pdfPath, wanted, { dpi: FIGURE_DPI });
		const byPage = new Map(rendered.map((r) => [r.page, r.png]));
		await fs.mkdir(figuresDir(key), { recursive: true });
		for (const caption of captions) {
			const png = byPage.get(caption.page);
			if (!png) continue;
			const file = `figure-${caption.number}.png`;
			await fs.writeFile(path.join(figuresDir(key), file), png);
			figures.push({ ...caption, file });
		}
	}
	updateManifest(key, pdfPath, (manifest) => { manifest.figures = figures; });
	return figures;
}
