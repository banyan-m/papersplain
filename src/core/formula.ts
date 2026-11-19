/**
 * Formula cards — an annotated formula with draggable parameters and a
 * linked plot; and derivations — a formula sequence stepped through line by
 * line. (papersplainer, owner 2026-11-19.)
 *
 * A card is DATA, never code: LaTeX with `\tangle{name}` markers (a number
 * the learner drags) and `\note{name}{...}` markers (a part with an
 * explanation arrowed to it), the parameters' ranges and colours, the notes'
 * text, and a plot described by arithmetic expressions (core/expr.ts). The
 * guide emits one, or names one from the shipped library; nothing a model
 * wrote is ever executed.
 *
 * The on-screen formula is drawn by the vendored TangleLatex front end
 * (components/formula/vendor). normalizeFormulaCard is the port of the
 * validation its Python class did, plus the plot's own checks. Pure.
 */

import { ExpressionError, parseExpression, type Compiled } from "./expr.ts";

// ─── What the guide (or the library) writes ─────────────────────────────────

export interface FormulaParameterInput {
	value: number;
	min_value?: number;
	max_value?: number;
	step?: number;
	/** Decimals shown. */
	digits?: number;
	/** "number" shows the value in the formula; "symbol" shows the symbol
	 *  until the learner drags it. */
	display?: "number" | "symbol";
	/** LaTeX for the symbol (default: the name). */
	symbol?: string;
	/** Spoken label for the control. */
	label?: string;
	/** A CSS colour, or one per theme. Default: the next palette colour. */
	color?: string | { light: string; dark: string };
}

export type FormulaNoteInput = string | { text: string; side?: "auto" | "top" | "bottom"; color?: string | { light: string; dark: string } };

export interface PlotAxis { label?: string; min?: number; max?: number }

export type FormulaPlotInput =
	| {
			kind: "curve";
			/** The horizontal variable's range; expressions call it `x`. */
			x: { label?: string; min: number; max: number };
			y?: PlotAxis;
			/** One to four curves: y as an expression of x and the parameters. */
			curves: { expr: string; label?: string }[];
	  }
	| {
			kind: "bars";
			y?: PlotAxis;
			/** Two to twelve bars: each height an expression of the parameters. */
			bars: { label: string; expr: string }[];
	  };

export interface FormulaCardInput {
	title: string;
	/** One sentence under the card, in plain words. */
	caption?: string;
	latex: string;
	parameters: Record<string, FormulaParameterInput>;
	notes?: Record<string, FormulaNoteInput>;
	plot?: FormulaPlotInput;
}

// ─── What the card component receives (everything resolved) ─────────────────

export interface ThemedColor { light: string; dark: string }

export interface FormulaParameter {
	value: number;
	min_value: number;
	max_value: number;
	step: number;
	digits: number;
	display: "number" | "symbol";
	symbol: string;
	label: string;
	pixels_per_step: number;
	color: ThemedColor;
}

export interface FormulaNote { text: string; side: "auto" | "top" | "bottom"; color: ThemedColor; param: string | null }

export interface FormulaCard {
	title: string;
	caption?: string;
	latex: string;
	parameters: Record<string, FormulaParameter>;
	notes: Record<string, FormulaNote>;
	plot?: FormulaPlotInput;
	/** Set when the card came from the shipped library. */
	libraryId?: string;
}

export interface DerivationStep { tex: string; note: string }
export interface Derivation { title?: string; steps: DerivationStep[] }

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

// ─── Validation ─────────────────────────────────────────────────────────────

/** The widget's palette, in order; notes continue it after the parameters. */
export const FORMULA_COLORS: readonly ThemedColor[] = [
	{ light: "#246bce", dark: "#75a7ff" },
	{ light: "#b45b1b", dark: "#ffad66" },
	{ light: "#147a68", dark: "#5ed5bd" },
	{ light: "#a23b78", dark: "#f08bc2" },
	{ light: "#6f5cbd", dark: "#b9a8ff" },
];

const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const TANGLE = /\\tangle\{([A-Za-z][A-Za-z0-9_-]*)\}/g;
const NOTE = /\\note\{([A-Za-z][A-Za-z0-9_-]*)\}/g;
export const MAX_PARAMETERS = 6;
export const MAX_NOTES = 6;
export const MAX_CURVES = 4;
export const MAX_BARS = 12;
export const MAX_DERIVATION_STEPS = 16;
const MAX_LATEX = 1200;
/** Samples per curve the validator (and the plot) evaluates. */
export const PLOT_SAMPLES = 160;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;

function colorOf(value: unknown, index: number, what: string, errors: string[]): ThemedColor {
	if (value === undefined || value === null) return { ...FORMULA_COLORS[index % FORMULA_COLORS.length]! };
	if (typeof value === "string" && value !== "") return { light: value, dark: value };
	const v = value as Partial<ThemedColor>;
	if (typeof value === "object" && typeof v.light === "string" && v.light && typeof v.dark === "string" && v.dark) return { light: v.light, dark: v.dark };
	errors.push(`${what} color must be a CSS color string or { light, dark }`);
	return { ...FORMULA_COLORS[index % FORMULA_COLORS.length]! };
}

/** Expression names may not contain "-"; a parameter named "x-0" could never
 *  be read by a plot. Plots also reserve `x`. */
const EXPR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkAxis(axis: unknown, what: string, errors: string[]): void {
	if (axis === undefined) return;
	const a = axis as PlotAxis;
	if (typeof axis !== "object" || axis === null) { errors.push(`${what} must be an object`); return; }
	if (a.min !== undefined && !finite(a.min)) errors.push(`${what}.min must be a finite number`);
	if (a.max !== undefined && !finite(a.max)) errors.push(`${what}.max must be a finite number`);
	if (finite(a.min) && finite(a.max) && a.min >= a.max) errors.push(`${what}.min must be less than ${what}.max`);
	if (a.label !== undefined && typeof a.label !== "string") errors.push(`${what}.label must be a string`);
}

/** A few settings of every parameter at once: all at their starting value,
 *  all at their minimum, all at their maximum. A plot must survive them. */
function parameterCorners(parameters: Record<string, FormulaParameter>): Record<string, number>[] {
	const pick = (f: (p: FormulaParameter) => number) => Object.fromEntries(Object.entries(parameters).map(([name, p]) => [name, f(p)]));
	return [pick((p) => p.value), pick((p) => p.min_value), pick((p) => p.max_value)];
}

function compile(expr: unknown, what: string, allowed: ReadonlySet<string>, errors: string[]): Compiled | null {
	if (typeof expr !== "string") { errors.push(`${what} must be an expression string`); return null; }
	try {
		const parsed = parseExpression(expr);
		const unknown = parsed.variables.filter((name) => !allowed.has(name));
		if (unknown.length > 0) {
			errors.push(`${what} reads ${unknown.map((n) => `"${n}"`).join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a parameter${allowed.has("x") ? " or x" : ""}`);
			return null;
		}
		return parsed.evaluate;
	} catch (err) {
		errors.push(`${what}: ${err instanceof ExpressionError ? err.message : "not a valid expression"}`);
		return null;
	}
}

function checkPlot(plot: unknown, parameters: Record<string, FormulaParameter>, errors: string[]): void {
	if (typeof plot !== "object" || plot === null) { errors.push("plot must be an object"); return; }
	const p = plot as FormulaPlotInput;
	const names = Object.keys(parameters);
	for (const name of names) if (!EXPR_NAME.test(name)) errors.push(`parameter "${name}" cannot be used in a plot: plot names may not contain "-"`);
	checkAxis(p.y, "plot.y", errors);
	const corners = parameterCorners(parameters);
	if (p.kind === "curve") {
		if (names.includes("x")) errors.push('a curve plot reserves the name "x" for the horizontal axis: rename the parameter');
		const x = p.x as { min?: unknown; max?: unknown; label?: unknown } | undefined;
		if (!x || !finite(x.min) || !finite(x.max) || x.min >= x.max) { errors.push("plot.x needs finite min and max with min < max"); return; }
		if (x.label !== undefined && typeof x.label !== "string") errors.push("plot.x.label must be a string");
		if (!Array.isArray(p.curves) || p.curves.length < 1 || p.curves.length > MAX_CURVES) { errors.push(`plot.curves needs 1 to ${MAX_CURVES} curves`); return; }
		const allowed = new Set([...names, "x"]);
		p.curves.forEach((curve, i) => {
			const what = `plot.curves[${i}].expr`;
			if (curve?.label !== undefined && typeof curve.label !== "string") errors.push(`plot.curves[${i}].label must be a string`);
			const f = compile(curve?.expr, what, allowed, errors);
			if (!f) return;
			// The curve must be drawable: finite at most sample points, for the
			// starting values and at both ends of every parameter's range.
			for (const [c, scope] of corners.entries()) {
				let ok = 0;
				for (let s = 0; s < PLOT_SAMPLES; s++) {
					const xv = (x.min as number) + ((x.max as number) - (x.min as number)) * (s / (PLOT_SAMPLES - 1));
					if (Number.isFinite(f({ ...scope, x: xv }))) ok++;
				}
				if (ok < PLOT_SAMPLES / 2) {
					errors.push(`${what} is not a finite number over most of the x range ${c === 0 ? "at the starting values" : c === 1 ? "with every parameter at its minimum" : "with every parameter at its maximum"}`);
					break;
				}
			}
		});
		return;
	}
	if (p.kind === "bars") {
		if (!Array.isArray(p.bars) || p.bars.length < 2 || p.bars.length > MAX_BARS) { errors.push(`plot.bars needs 2 to ${MAX_BARS} bars`); return; }
		const allowed = new Set(names);
		p.bars.forEach((bar, i) => {
			if (!text(bar?.label, 40)) errors.push(`plot.bars[${i}].label must be a short non-empty string`);
			const f = compile(bar?.expr, `plot.bars[${i}].expr`, allowed, errors);
			if (f && !corners.every((scope) => Number.isFinite(f(scope)))) errors.push(`plot.bars[${i}].expr is not a finite number across the parameters' ranges`);
		});
		return;
	}
	errors.push('plot.kind must be "curve" or "bars"');
}

/** Validate a card and resolve every default. Collects every problem it can
 *  find, so one round of feedback fixes them all. */
export function normalizeFormulaCard(input: unknown): Checked<FormulaCard> {
	const errors: string[] = [];
	const card = input as Partial<FormulaCardInput> | null;
	if (typeof card !== "object" || card === null) return { ok: false, errors: ["the card must be an object"] };
	if (!text(card.title, 80)) errors.push("title must be a non-empty string of at most 80 characters");
	if (card.caption !== undefined && (typeof card.caption !== "string" || card.caption.length > 240)) errors.push("caption must be a string of at most 240 characters");
	if (!text(card.latex, MAX_LATEX)) return { ok: false, errors: [...errors, `latex must be a non-empty string of at most ${MAX_LATEX} characters`] };
	const latex = card.latex;

	const markers = new Set([...latex.matchAll(TANGLE)].map((m) => m[1]!));
	if (markers.size === 0) errors.push("latex must contain at least one \\tangle{name} marker");
	const raw = card.parameters;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: [...errors, "parameters must map each \\tangle name to its configuration"] };
	const configured = Object.keys(raw);
	if (configured.length > MAX_PARAMETERS) errors.push(`at most ${MAX_PARAMETERS} parameters`);
	const missing = [...markers].filter((name) => !configured.includes(name)).sort();
	const unused = configured.filter((name) => !markers.has(name)).sort();
	if (missing.length) errors.push(`missing configuration for parameter marker(s): ${missing.join(", ")}`);
	if (unused.length) errors.push(`parameter configuration not referenced by latex: ${unused.join(", ")}`);

	const parameters: Record<string, FormulaParameter> = {};
	configured.forEach((name, index) => {
		const p = raw[name] as Partial<FormulaParameterInput> | null;
		if (!NAME.test(name)) { errors.push(`parameter name "${name}" must start with a letter and contain only letters, numbers, underscores, or hyphens`); return; }
		if (typeof p !== "object" || p === null) { errors.push(`parameter "${name}" configuration must be an object`); return; }
		const min = p.min_value ?? -100, max = p.max_value ?? 100, step = p.step ?? 1, digits = p.digits ?? 1;
		const before = errors.length;
		if (!finite(p.value)) errors.push(`parameter "${name}" value must be a finite number`);
		if (!finite(min) || !finite(max) || min >= max) errors.push(`parameter "${name}" min_value must be less than max_value`);
		if (!finite(step) || step <= 0) errors.push(`parameter "${name}" step must be positive`);
		if (finite(p.value) && finite(min) && finite(max) && (p.value < min || p.value > max)) errors.push(`parameter "${name}" value must be between min_value and max_value`);
		if (!Number.isInteger(digits) || digits < 0 || digits > 6) errors.push(`parameter "${name}" digits must be an integer from 0 to 6`);
		const display = p.display ?? "number";
		if (display !== "number" && display !== "symbol") errors.push(`parameter "${name}" display must be "number" or "symbol"`);
		const symbol = p.symbol ?? name, label = p.label ?? `parameter ${name}`;
		if (typeof symbol !== "string" || symbol === "") errors.push(`parameter "${name}" symbol must be a non-empty string`);
		if (typeof label !== "string" || label === "") errors.push(`parameter "${name}" label must be a non-empty string`);
		const color = colorOf(p.color, index, `parameter "${name}"`, errors);
		if (errors.length > before) return;
		parameters[name] = { value: p.value as number, min_value: min, max_value: max, step, digits, display, symbol, label, pixels_per_step: 7, color };
	});

	const noteMarkers = new Set([...latex.matchAll(NOTE)].map((m) => m[1]!));
	const rawNotes = card.notes ?? {};
	const notes: Record<string, FormulaNote> = {};
	if (typeof rawNotes !== "object" || rawNotes === null || Array.isArray(rawNotes)) {
		errors.push("notes must map each \\note name to its text");
	} else {
		const noteNames = Object.keys(rawNotes);
		if (noteNames.length > MAX_NOTES) errors.push(`at most ${MAX_NOTES} notes`);
		const missingNotes = [...noteMarkers].filter((name) => !noteNames.includes(name)).sort();
		const unusedNotes = noteNames.filter((name) => !noteMarkers.has(name)).sort();
		if (missingNotes.length) errors.push(`missing note for marker(s): ${missingNotes.join(", ")}`);
		if (unusedNotes.length) errors.push(`note(s) not referenced by latex: ${unusedNotes.join(", ")}`);
		noteNames.forEach((name, index) => {
			const given = rawNotes[name];
			const note = typeof given === "string" ? { text: given } : given;
			if (!NAME.test(name)) { errors.push(`note name "${name}" must start with a letter and contain only letters, numbers, underscores, or hyphens`); return; }
			if (typeof note !== "object" || note === null) { errors.push(`note "${name}" must be a string or an object`); return; }
			if (!text(note.text, 200)) { errors.push(`note "${name}" text must be a non-empty string of at most 200 characters`); return; }
			const side = note.side ?? "auto";
			if (side !== "auto" && side !== "top" && side !== "bottom") { errors.push(`note "${name}" side must be "auto", "top", or "bottom"`); return; }
			// A note that wraps exactly one parameter explains that parameter:
			// it takes the parameter's colour and lights up while it is dragged.
			const wrapped = new RegExp(`\\\\note\\{${name}\\}\\{\\s*\\\\tangle\\{([A-Za-z][A-Za-z0-9_-]*)\\}\\s*\\}`).exec(latex);
			const param = wrapped && parameters[wrapped[1]!] ? wrapped[1]! : null;
			const color = note.color === undefined && param ? { ...parameters[param]!.color } : colorOf(note.color, configured.length + index, `note "${name}"`, errors);
			notes[name] = { text: note.text, side, color, param };
		});
	}

	if (card.plot !== undefined && errors.length === 0) checkPlot(card.plot, parameters, errors);
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: { title: card.title!.trim(), ...(card.caption?.trim() ? { caption: card.caption.trim() } : {}), latex, parameters, notes, ...(card.plot ? { plot: card.plot } : {}) },
	};
}

export function normalizeDerivation(input: unknown): Checked<Derivation> {
	const d = input as { title?: unknown; steps?: unknown } | null;
	if (typeof d !== "object" || d === null) return { ok: false, errors: ["the derivation must be an object"] };
	const errors: string[] = [];
	if (d.title !== undefined && d.title !== null && (typeof d.title !== "string" || d.title.length > 80)) errors.push("title must be a string of at most 80 characters");
	if (!Array.isArray(d.steps) || d.steps.length === 0) return { ok: false, errors: [...errors, "steps must be a non-empty list of { tex, note }"] };
	if (d.steps.length > MAX_DERIVATION_STEPS) errors.push(`at most ${MAX_DERIVATION_STEPS} steps`);
	const steps: DerivationStep[] = [];
	d.steps.forEach((raw: unknown, i: number) => {
		const step = raw as { tex?: unknown; note?: unknown } | null;
		if (typeof step !== "object" || step === null || !text(step.tex, MAX_LATEX)) { errors.push(`step ${i + 1} must have a non-empty string tex`); return; }
		if (step.note !== undefined && step.note !== null && (typeof step.note !== "string" || step.note.length > 240)) { errors.push(`step ${i + 1} note must be a string of at most 240 characters`); return; }
		steps.push({ tex: step.tex, note: typeof step.note === "string" ? step.note : "" });
	});
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { ...(typeof d.title === "string" && d.title.trim() ? { title: d.title.trim() } : {}), steps } };
}

// ─── What KaTeX is given (shared by the server-side check and the tests) ────

/** The formula as the widget hands it to KaTeX: each \tangle{name} becomes
 *  an \htmlData span around its value or symbol; \note is a macro. */
export function katexSourceOf(card: Pick<FormulaCard, "latex" | "parameters">): string {
	return card.latex.replace(TANGLE, (_, name: string) => {
		const p = card.parameters[name];
		const content = !p ? name : p.display === "symbol" ? p.symbol : p.value.toFixed(p.digits);
		return `\\htmlData{tangle-param=${name}}{${content}}`;
	});
}
export const KATEX_FORMULA_OPTIONS = {
	macros: { "\\note": "\\htmlData{note=#1}{#2}" },
	trust: (context: { command: string }) => context.command === "\\htmlData",
} as const;

/** The parameters' starting values, as the widget's `values`. */
export function startingValues(card: Pick<FormulaCard, "parameters">): Record<string, number> {
	return Object.fromEntries(Object.entries(card.parameters).map(([name, p]) => [name, p.value]));
}
