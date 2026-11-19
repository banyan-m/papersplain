/**
 * The last check before a formula reaches the learner: does KaTeX accept it?
 * core/formula.ts validates a card's structure and its plot; this renders
 * the LaTeX exactly as the widget will (same marker expansion, same macro,
 * same trust rule) and reports KaTeX's own message when it refuses, so the
 * guide can fix the source instead of the learner seeing a broken card.
 */
import katex from "katex";
import { KATEX_FORMULA_OPTIONS, katexSourceOf, type Derivation, type FormulaCard } from "../core/formula.ts";

function problem(tex: string, options: Record<string, unknown>): string | null {
	try {
		katex.renderToString(tex, { ...options, throwOnError: true, strict: "ignore" });
		return null;
	} catch (err) {
		return (err instanceof Error ? err.message : String(err)).replace(/^KaTeX parse error:\s*/, "");
	}
}

/** Inline $math$ inside a note's text (odd-indexed parts, as the widget splits it). */
function inlineMath(text: string): string[] {
	return text.split("$").filter((_, i) => i % 2 === 1);
}

export function formulaLatexProblems(card: FormulaCard): string[] {
	const problems: string[] = [];
	const formula = problem(katexSourceOf(card), { ...KATEX_FORMULA_OPTIONS, displayMode: true });
	if (formula) problems.push(`latex does not render: ${formula}`);
	for (const [name, parameter] of Object.entries(card.parameters)) {
		const symbol = problem(parameter.symbol, {});
		if (symbol) problems.push(`parameter "${name}" symbol does not render: ${symbol}`);
	}
	for (const [name, note] of Object.entries(card.notes)) {
		for (const math of inlineMath(note.text)) {
			const bad = problem(math, {});
			if (bad) problems.push(`note "${name}" math $${math}$ does not render: ${bad}`);
		}
	}
	return problems;
}

export function derivationLatexProblems(derivation: Derivation): string[] {
	const problems: string[] = [];
	derivation.steps.forEach((step, i) => {
		const bad = problem(step.tex, { displayMode: true });
		if (bad) problems.push(`step ${i + 1} tex does not render: ${bad}`);
	});
	return problems;
}
