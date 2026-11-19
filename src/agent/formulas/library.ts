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
import { ML_ACTIVATION_CARDS } from "./ml-activations.ts";
import { ML_TRAINING_CARDS } from "./ml-training.ts";
import { ML_GENERATIVE_RL_CARDS } from "./ml-generative-rl.ts";
import { STATS_DISTRIBUTION_CARDS } from "./stats-distributions.ts";
import { STATS_INFERENCE_CARDS } from "./stats-inference.ts";
import { BIO_SEQUENCE_CARDS } from "./bio-sequence.ts";
import { BIO_MODEL_CARDS } from "./bio-models.ts";

export const FORMULA_LIBRARY: Readonly<Record<string, FormulaCardInput>> = Object.freeze({
	...ML_CARDS,
	...ML_ACTIVATION_CARDS,
	...ML_TRAINING_CARDS,
	...ML_GENERATIVE_RL_CARDS,
	...STATS_DISTRIBUTION_CARDS,
	...STATS_INFERENCE_CARDS,
	...BIO_SEQUENCE_CARDS,
	...BIO_MODEL_CARDS,
});

/** Library names: lowercase words joined by hyphens. */
export const LIBRARY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** "name: Title; name: Title; …" — what the guide reads to choose a card. */
export function libraryIndex(library: Readonly<Record<string, FormulaCardInput>> = FORMULA_LIBRARY): string {
	return Object.entries(library).map(([name, card]) => `${name}: ${card.title}`).join("; ");
}
