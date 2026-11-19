/**
 * Short forms for writing library cards. A card is still plain data
 * (core/formula.ts FormulaCardInput); these only cut the repetition.
 */
import type { FormulaCardInput, FormulaParameterInput, FormulaPlotInput } from "../../core/formula.ts";

const decimals = (step: number): number => Math.min(6, (String(step).split(".")[1] ?? "").length);

/** A parameter shown as its number. */
export function num(value: number, min: number, max: number, step: number, label: string): FormulaParameterInput {
	return { value, min_value: min, max_value: max, step, digits: decimals(step), label };
}

/** A parameter shown as its symbol until it is dragged. */
export function sym(symbol: string, value: number, min: number, max: number, step: number, label: string): FormulaParameterInput {
	return { ...num(value, min, max, step, label), display: "symbol", symbol };
}

type Axis = readonly [min: number, max: number, label?: string];

/** A curve plot: x range, then each curve as an expression or [expression, label]. */
export function curve(x: Axis, curves: readonly (string | readonly [expr: string, label: string])[], y?: Axis): FormulaPlotInput {
	return {
		kind: "curve",
		x: { min: x[0], max: x[1], ...(x[2] ? { label: x[2] } : {}) },
		...(y ? { y: { min: y[0], max: y[1], ...(y[2] ? { label: y[2] } : {}) } } : {}),
		curves: curves.map((c) => (typeof c === "string" ? { expr: c } : { expr: c[0], label: c[1] })),
	};
}

/** A bar chart: each bar as [label, expression]. */
export function bars(entries: readonly (readonly [label: string, expr: string])[], y?: Axis): FormulaPlotInput {
	return {
		kind: "bars",
		...(y ? { y: { min: y[0], max: y[1], ...(y[2] ? { label: y[2] } : {}) } } : {}),
		bars: entries.map(([label, expr]) => ({ label, expr })),
	};
}

export function card(
	title: string,
	caption: string,
	latex: string,
	parameters: Record<string, FormulaParameterInput>,
	notes: Record<string, string>,
	plot: FormulaPlotInput,
): FormulaCardInput {
	return { title, caption, latex, parameters, notes, plot };
}

/** `[label, expr]` bars for n = from..to of a per-index expression (`n` is replaced). */
export function series(from: number, to: number, expr: (n: number) => string, label: (n: number) => string = String): [string, string][] {
	const out: [string, string][] = [];
	for (let n = from; n <= to; n++) out.push([label(n), expr(n)]);
	return out;
}
