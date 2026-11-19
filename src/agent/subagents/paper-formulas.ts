import { randomUUID } from "node:crypto";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { piEngineFor, type PiEngine } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
import { backgroundCaptureStream, createBackgroundCapture } from "../background-capture.ts";
import { workerRequestStream } from "../worker-request-admission.ts";
import { normalizeFormulaCard, type FormulaCardInput } from "../../core/formula.ts";
import type { PaperFormulas } from "../../core/paper-cache.ts";
import { formulaLatexProblems } from "../formula-check.ts";
import { FORMULA_LIBRARY, LIBRARY_NAME, libraryIndex } from "../formulas/library.ts";
import { streamOnce } from "./visual-maker.ts";
import { pdfExtract } from "./pdf-ops.ts";
import { readManifest, updateManifest } from "./paper-cache-store.ts";

/**
 * papersplainer: the per-paper formula pass (owner, 2026-11-19).
 *
 * When a paper is first read, one model call on the cheap slot goes over its
 * text and prepares formula cards for it: which library cards the paper
 * uses, and new cards for its own key equations. The result is kept in the
 * paper's cache, so every later conversation on the paper (any mode) can
 * show them at once.
 *
 * The model returns DATA and nothing here trusts it: every card goes through
 * the same validation and KaTeX check as a card the guide writes by hand,
 * and anything that would not draw is dropped. A failed pass leaves the
 * paper without prepared cards; the guide can still write cards itself.
 *
 * Text only: equations that survive in the PDF's text layer as garbled
 * symbols are a known weak spot (the model is told to skip what it cannot
 * read rather than guess).
 */

export const MAX_PAPER_CARDS = 12;
/** About 20k tokens of paper text: enough for the methods of most papers. */
const MAX_PAPER_CHARS = 80_000;

const INSTRUCTIONS = [
	"You prepare interactive formula cards for one research paper. You are given the paper's text (extracted from the PDF, so equations may be garbled) and a library of ready-made cards.",
	"",
	"Reply with ONE JSON object and nothing else:",
	'{ "library": ["name", ...], "cards": { "short-name": { ...card... }, ... } }',
	"",
	"library: names from the library list whose formula this paper actually uses or builds on (for example its loss, its activation, its noise schedule, its scoring function). At most 12. Only names from the list.",
	"",
	`cards: at most ${MAX_PAPER_CARDS} new cards for the paper's OWN key equations that the library does not cover: the ones a reader must understand to follow the method. Skip definitions with nothing to vary, and skip any equation you cannot read with confidence. Fewer good cards are better than many weak ones. The key is a short lowercase name with hyphens that includes the equation number when the paper gives one ("eq-3-loss").`,
	"",
	"A card:",
	'{ "title": string, "caption": one plain sentence saying what the formula does and where it is in the paper ("Eq. 3, p. 5"),',
	'  "latex": KaTeX source in the PAPER\'S notation. Mark each number the reader should vary with \\tangle{name}. Wrap each part worth explaining in \\note{name}{...}; wrapping exactly one \\tangle gives the note that parameter\'s colour.',
	'  "parameters": { name: { "value": number, "min_value": number, "max_value": number, "step": number, "label": plain name, optional "display": "symbol" with "symbol": LaTeX } }  (one per \\tangle name, at most 6; names use letters, digits, underscores),',
	'  "notes": { name: short explanation }  (one per \\note name, at most 6; **bold** and inline $math$ allowed),',
	'  "plot": { "kind": "curve", "x": { "label", "min", "max" }, "y": { "min", "max" }, "curves": [{ "expr", "label" }] }  (1 to 4 curves; expr gives y from x and the parameter names)',
	'       or { "kind": "bars", "y": { "min", "max" }, "bars": [{ "label", "expr" }] }  (2 to 12 bars; expr uses the parameter names) }',
	"",
	"Expressions use + - * / ^, comparisons, and: exp log log2 log10 sqrt abs sign floor ceil round sin cos tan sinh cosh tanh pow min max sigmoid relu softplus step clamp if erf gamma lgamma binom normpdf normcdf, with constants pi and e. No other names.",
	"Mark two or three parameters per card, not every symbol. Choose ranges the paper's own values fall inside. Give y a fixed min and max so the curve visibly moves.",
	"Every card needs at least one note and a plot. In JSON, write each LaTeX backslash as two backslashes.",
].join("\n");

export interface PaperFormulaPassOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	chatId?: string;
	onUsage?: (usage: Usage) => void;
	library?: Readonly<Record<string, FormulaCardInput>>;
}

export interface PaperFormulaPassResult extends PaperFormulas {
	/** Cards the model proposed that were dropped, with the first reason each. */
	rejected: { name: string; reason: string }[];
}

/** The first balanced JSON object in a reply (models sometimes wrap it in a
 *  code fence or a sentence). Null when there is none. */
export function extractJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0, inString = false, escaped = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) {
			try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
		}
	}
	return null;
}

/** Keep what is usable from a model's reply: known library names, and cards
 *  that validate and render. Pure — exported for tests. */
export function screenPaperFormulas(reply: unknown, library: Readonly<Record<string, FormulaCardInput>> = FORMULA_LIBRARY): Omit<PaperFormulaPassResult, "createdAt"> {
	const r = (typeof reply === "object" && reply !== null ? reply : {}) as { library?: unknown; cards?: unknown };
	const names = Array.isArray(r.library)
		? [...new Set(r.library.filter((n): n is string => typeof n === "string" && Object.hasOwn(library, n)))].slice(0, 12)
		: [];
	const cards: Record<string, FormulaCardInput> = {};
	const rejected: { name: string; reason: string }[] = [];
	const proposed = typeof r.cards === "object" && r.cards !== null && !Array.isArray(r.cards) ? Object.entries(r.cards as Record<string, unknown>) : [];
	for (const [rawName, card] of proposed) {
		const name = rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		if (Object.keys(cards).length >= MAX_PAPER_CARDS) { rejected.push({ name: rawName, reason: `more than ${MAX_PAPER_CARDS} cards` }); continue; }
		if (!LIBRARY_NAME.test(name)) { rejected.push({ name: rawName, reason: "the name has no letters or digits" }); continue; }
		if (Object.hasOwn(library, name) || Object.hasOwn(cards, name)) { rejected.push({ name: rawName, reason: "the name is already taken" }); continue; }
		const checked = normalizeFormulaCard(card);
		if (!checked.ok) { rejected.push({ name: rawName, reason: checked.errors[0]! }); continue; }
		const latex = formulaLatexProblems(checked.value);
		if (latex.length > 0) { rejected.push({ name: rawName, reason: latex[0]! }); continue; }
		if (!checked.value.plot || Object.keys(checked.value.notes).length === 0) { rejected.push({ name: rawName, reason: "a card needs a plot and at least one note" }); continue; }
		cards[name] = card as FormulaCardInput;
	}
	return { library: names, cards, rejected };
}

/** One pass over a paper's text. Throws on provider failure or abort; a
 *  reply that is not JSON yields an empty result (nothing prepared). */
export async function runPaperFormulaPass(paperText: string, opts: PaperFormulaPassOptions = {}): Promise<PaperFormulaPassResult> {
	const library = opts.library ?? FORMULA_LIBRARY;
	const engine = opts.engine ?? piEngineFor("demoBuilder");
	const sessionId = randomUUID();
	const capture = createBackgroundCapture({ role: "demoBuilder", runId: sessionId, sourceId: opts.chatId });
	const streamEngine = { ...engine, streamFn: backgroundCaptureStream(workerRequestStream(engine.streamFn), capture) };
	const text = paperText.length > MAX_PAPER_CHARS ? `${paperText.slice(0, MAX_PAPER_CHARS)}\n\n[The paper continues; the rest was cut for length.]` : paperText;
	const messages: Message[] = [
		{
			role: "user",
			content: [`Library cards (name: title): ${libraryIndex(library)}`, "", "The paper:", "", text].join("\n"),
			timestamp: Date.now(),
		},
	];
	const reply = await streamOnce(
		streamEngine,
		INSTRUCTIONS,
		messages,
		[],
		sessionId,
		engine.level,
		opts.abortSignal,
		opts.chatId ? providerEventObserver(opts.chatId, "job:demoBuilder") : undefined,
		capture,
	);
	opts.onUsage?.(reply.usage);
	const replyText = reply.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("");
	return { ...screenPaperFormulas(extractJsonObject(replyText), library), createdAt: new Date().toISOString() };
}

const passes = new Map<string, Promise<PaperFormulas | null>>();

/**
 * Prepare a paper's formula cards once. Later calls for the same paper get
 * the stored result; a pass already running is shared. Resolves null when no
 * model is available for the pass, or it fails: nothing is stored, so a later
 * session on the paper tries again.
 */
export function ensurePaperFormulas(pdfPath: string, key: string, opts: PaperFormulaPassOptions & { engine: PiEngine | undefined }): Promise<PaperFormulas | null> {
	const known = readManifest(key)?.formulas;
	if (known) return Promise.resolve(known);
	if (!opts.engine) return Promise.resolve(null);
	const running = passes.get(key);
	if (running) return running;
	const run = (async (): Promise<PaperFormulas | null> => {
		const text = await pdfExtract(pdfPath, "all");
		if (text.trim() === "") return null; // a scanned PDF: nothing to read here
		const { rejected, ...formulas } = await runPaperFormulaPass(text, opts);
		if (rejected.length > 0) console.error(`[paper-formulas ${key}] dropped ${rejected.length} card(s):`, rejected.map((r) => `${r.name}: ${r.reason}`).join(" | "));
		updateManifest(key, pdfPath, (manifest) => { manifest.formulas = formulas; });
		return formulas;
	})()
		.catch((err: unknown) => {
			if (!opts.abortSignal?.aborted) console.error(`[paper-formulas ${key}]`, err);
			return null;
		})
		.finally(() => passes.delete(key));
	passes.set(key, run);
	return run;
}
