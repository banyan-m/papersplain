/**
 * The shipped formula-card library (papersplainer, owner 2026-11-19): cards
 * for formulas that recur across papers, ready to show with no model call.
 * The cards are plain data modules beside this one (no runtime file reads). Every card must pass normalizeFormulaCard and the
 * KaTeX check — tests/papersplainer-formula-library.test.ts holds the whole
 * library to that.
 *
 * The guide is given the index (name: title) in the `formula` tool's
 * description, so it picks a card by name without a search step.
 */
import type { FormulaCardInput } from "../../core/formula.ts";
import { ML_CARDS } from "./ml.ts";

export const FORMULA_LIBRARY: Readonly<Record<string, FormulaCardInput>> = Object.freeze({
	...ML_CARDS,
});

/** Library names: lowercase words joined by hyphens. */
export const LIBRARY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** "name: Title; name: Title; …" — what the guide reads to choose a card. */
export function libraryIndex(library: Readonly<Record<string, FormulaCardInput>> = FORMULA_LIBRARY): string {
	return Object.entries(library).map(([name, card]) => `${name}: ${card.title}`).join("; ");
}
