import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { normalizeDerivation, normalizeFormulaCard, type Derivation, type FormulaCard, type FormulaCardInput } from "../../core/formula.ts";
import { derivationLatexProblems, formulaLatexProblems } from "../formula-check.ts";
import { FORMULA_LIBRARY, libraryIndex } from "../formulas/library.ts";

/**
 * papersplainer: formula and derivation. Instant and model-free — the guide
 * (or the teacher) supplies DATA and the app draws it:
 *
 *   formula     an annotated formula whose coloured numbers the learner
 *               drags, with a plot that follows. From the shipped library by
 *               name, or a card written inline.
 *   derivation  a derivation the learner steps through line by line.
 *
 * Nothing in a card is executed: plots are arithmetic expressions parsed by
 * core/expr.ts. A card that would not draw (unknown names, LaTeX KaTeX
 * refuses, a plot that is not finite) is refused with every reason, so one
 * correction fixes it and the learner never sees a broken card.
 */

const parameterInput = Type.Object({
	value: Type.Number({ description: "Starting value." }),
	min_value: Type.Optional(Type.Number()),
	max_value: Type.Optional(Type.Number()),
	step: Type.Optional(Type.Number({ description: "Drag increment, e.g. 0.1." })),
	digits: Type.Optional(Type.Integer({ minimum: 0, maximum: 6, description: "Decimals shown." })),
	display: Type.Optional(Type.Union([Type.Literal("number"), Type.Literal("symbol")], { description: "number (default) shows the value in the formula; symbol shows the symbol until dragged." })),
	symbol: Type.Optional(Type.String({ description: "LaTeX for the symbol when display is symbol, e.g. \\\\sigma." })),
	label: Type.Optional(Type.String({ description: "Plain name of the parameter, e.g. learning rate." })),
});

const axisInput = Type.Object({ label: Type.Optional(Type.String()), min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()) });

const cardInput = Type.Object({
	title: Type.String({ description: "Short name of the formula." }),
	caption: Type.Optional(Type.String({ description: "One plain sentence under the card." })),
	latex: Type.String({
		description:
			"KaTeX source. Mark each draggable number with \\tangle{name} (the same name may appear more than once). Wrap any part you want explained in \\note{name}{...}; wrapping exactly one \\tangle gives the note that parameter's colour.",
	}),
	parameters: Type.Record(Type.String(), parameterInput, { description: "One entry per \\tangle name (at most 6). Names: letters, digits, underscores." }),
	notes: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "One entry per \\note name (at most 6): a short explanation. **bold** and inline $math$ are allowed." })),
	plot: Type.Optional(
		Type.Union(
			[
				Type.Object({
					kind: Type.Literal("curve"),
					x: Type.Object({ label: Type.Optional(Type.String()), min: Type.Number(), max: Type.Number() }),
					y: Type.Optional(axisInput),
					curves: Type.Array(Type.Object({ expr: Type.String({ description: "y as an expression of x and the parameter names." }), label: Type.Optional(Type.String()) }), { minItems: 1, maxItems: 4 }),
				}),
				Type.Object({
					kind: Type.Literal("bars"),
					y: Type.Optional(axisInput),
					bars: Type.Array(Type.Object({ label: Type.String(), expr: Type.String({ description: "The bar's height as an expression of the parameter names." }) }), { minItems: 2, maxItems: 12 }),
				}),
			],
			{
				description:
					"What redraws as the learner drags. Expressions use + - * / ^, comparisons, the parameter names, and: exp log log2 log10 sqrt abs sign floor ceil round sin cos tan asin acos atan sinh cosh tanh pow min max sigmoid relu softplus step clamp if erf gamma lgamma binom normpdf normcdf, with constants pi and e. Give y a fixed min and max when the curve should visibly move rather than the axis rescale.",
			},
		),
	),
});

const formulaInput = Type.Object({
	name: Type.Optional(Type.String({ description: "A card from the library, by name. Use this whenever the formula is in the library." })),
	card: Type.Optional(cardInput),
});

function describe(card: FormulaCard): string {
	const parameters = Object.entries(card.parameters).map(([name, p]) => `${name} (${p.label}, ${p.min_value} to ${p.max_value}, starts at ${p.value})`);
	const notes = Object.entries(card.notes).map(([name, n]) => `${name}: ${n.text}`);
	const plot = !card.plot
		? "no plot"
		: card.plot.kind === "curve"
			? `a curve plot of ${card.plot.curves.map((c) => c.label ?? c.expr).join(", ")} over x from ${card.plot.x.min} to ${card.plot.x.max}`
			: `a bar chart of ${card.plot.bars.map((b) => b.label).join(", ")}`;
	return [
		`Shown to the learner: the formula card "${card.title}".`,
		`Formula: ${card.latex}`,
		`He can drag: ${parameters.join("; ")}.`,
		notes.length ? `Notes arrowed to the formula: ${notes.join(" | ")}.` : "No notes.",
		`Below it: ${plot}; while he drags, the earlier curve stays as a dashed reference.`,
		"Tell him which value to drag and what to watch for.",
	].join("\n");
}

export function createFormulaTool(
	library: Readonly<Record<string, FormulaCardInput>> = FORMULA_LIBRARY,
	/** Cards prepared for this conversation's paper (the per-paper pass);
	 *  read fresh on every call, since the pass finishes in the background. */
	paperCards: () => Readonly<Record<string, FormulaCardInput>> = () => ({}),
): AgentTool<typeof formulaInput> {
	return {
		name: "formula",
		label: "formula",
		description:
			"Show a formula the learner can play with: the formula with its parts explained by arrows, coloured numbers he drags in place, and a plot that redraws as he drags. Instant. " +
			"Use it when a formula's behaviour is the point: how a parameter changes a curve, a distribution, a score. Give `name` for a library card (or a card prepared for this paper, when you have been given their names), or `card` to write one for a formula neither has " +
			"(for a formula from the paper, keep the paper's notation and say which equation it is). Exactly one of the two. " +
			`Library cards: ${libraryIndex(library)}.`,
		parameters: formulaInput,
		execute: serverExecute("formula", formulaInput, ({ name, card }): { text: string; details: FormulaCard } => {
			if ((name === undefined) === (card === undefined)) throw new Error("give exactly one of name (a library card) or card (a card you write)");
			let source: unknown = card;
			if (name !== undefined) {
				const wanted = name.trim();
				const prepared = paperCards();
				const found = Object.hasOwn(prepared, wanted) ? prepared[wanted] : Object.hasOwn(library, wanted) ? library[wanted] : undefined;
				if (!found) throw new Error(`there is no card named "${name}". Use a name from the library list in this tool's description or from the cards prepared for this paper, or write the card yourself with card.`);
				source = found;
			}
			const checked = normalizeFormulaCard(source);
			if (!checked.ok) throw new Error(`the card was not shown. Fix and call again:\n- ${checked.errors.join("\n- ")}`);
			const latex = formulaLatexProblems(checked.value);
			if (latex.length > 0) throw new Error(`the card was not shown. Fix and call again:\n- ${latex.join("\n- ")}`);
			const shown: FormulaCard = name !== undefined ? { ...checked.value, libraryId: name.trim() } : checked.value;
			return { text: describe(shown), details: shown };
		}),
	};
}

const derivationInput = Type.Object({
	title: Type.Optional(Type.String({ description: "What is being derived." })),
	steps: Type.Array(
		Type.Object({
			tex: Type.String({ description: "One line of the derivation, KaTeX source." }),
			note: Type.Optional(Type.String({ description: "One short sentence: what was done to get this line." })),
		}),
		{ minItems: 1, maxItems: 16, description: "The lines in order. One move per line." },
	),
});

export const derivationTool: AgentTool<typeof derivationInput> = {
	name: "derivation",
	label: "derivation",
	description:
		"Show a derivation the learner steps through one line at a time, each line with a short note on what was done. Instant. " +
		"Use it where the paper (or the topic) goes from one equation to another and the steps between matter. One algebraic move per line; do not skip steps he would have to reconstruct.",
	parameters: derivationInput,
	execute: serverExecute("derivation", derivationInput, (input): { text: string; details: Derivation } => {
		const checked = normalizeDerivation(input);
		if (!checked.ok) throw new Error(`the derivation was not shown. Fix and call again:\n- ${checked.errors.join("\n- ")}`);
		const latex = derivationLatexProblems(checked.value);
		if (latex.length > 0) throw new Error(`the derivation was not shown. Fix and call again:\n- ${latex.join("\n- ")}`);
		return { text: `Shown to the learner: a ${checked.value.steps.length}-step derivation${checked.value.title ? ` "${checked.value.title}"` : ""}, which he steps through with next and previous.`, details: checked.value };
	}),
};
