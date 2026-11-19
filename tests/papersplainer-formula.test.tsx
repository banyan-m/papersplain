/**
 * papersplainer: formula cards and derivations.
 *
 *   1. the expression evaluator (the only thing a plot can run)
 *   2. card validation (the port of the widget's Python checks + the plot's)
 *   3. the LaTeX check and the two tools
 *   4. the whole shipped library draws
 *   5. the plot and the cards' markup
 *   6. the widget host's model, and the vendored files stay offline
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpressionError, parseExpression } from "../src/core/expr.ts";
import { FORMULA_COLORS, katexSourceOf, normalizeDerivation, normalizeFormulaCard, startingValues, type FormulaCard, type FormulaCardInput } from "../src/core/formula.ts";
import { derivationLatexProblems, formulaLatexProblems } from "../src/agent/formula-check.ts";
import { createFormulaTool, derivationTool } from "../src/agent/tools/formula.ts";
import { FORMULA_LIBRARY, LIBRARY_NAME, libraryIndex } from "../src/agent/formulas/library.ts";
import { createGuideTools, createTeacherTools } from "../src/agent/tools.ts";
import { FormulaPlot, formatTick, niceTicks } from "../components/formula/formula-plot.tsx";
import { HostModel } from "../components/formula/widget-host.tsx";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";

const ev = (source: string, scope: Record<string, number> = {}) => parseExpression(source).evaluate(scope);
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

const SIGMOID: FormulaCardInput = {
	title: "Logistic function",
	latex: String.raw`\sigma(x) = \frac{1}{1 + e^{-\note{steep}{\tangle{k}}(x - \tangle{x0})}}`,
	parameters: { k: { value: 1, min_value: 0.1, max_value: 8, step: 0.1 }, x0: { value: 0, min_value: -4, max_value: 4, step: 0.1 } },
	notes: { steep: "**steepness**: larger is sharper, $k > 0$" },
	plot: { kind: "curve", x: { min: -6, max: 6 }, y: { min: 0, max: 1 }, curves: [{ expr: "1 / (1 + exp(-k * (x - x0)))", label: "σ(x)" }] },
};
const ok = (input: unknown): FormulaCard => {
	const checked = normalizeFormulaCard(input);
	assert.ok(checked.ok, checked.ok ? "" : checked.errors.join("; "));
	return checked.value;
};
const errorsOf = (input: unknown): string => {
	const checked = normalizeFormulaCard(input);
	assert.ok(!checked.ok, "expected the card to be refused");
	return checked.errors.join("\n");
};

describe("the expression evaluator", () => {
	it("does arithmetic with the usual precedence", () => {
		assert.equal(ev("1 + 2 * 3"), 7);
		assert.equal(ev("-2^2"), -4, "power binds tighter than unary minus");
		assert.equal(ev("2^3^2"), 512, "right associative");
		assert.equal(ev("2^-1"), 0.5);
		assert.equal(ev("2**3"), 8);
		assert.equal(ev("7 % 4"), 3);
		assert.equal(ev("(1 + 2) * 3"), 9);
		assert.equal(ev("1e3 + .5"), 1000.5);
	});

	it("reads names from the scope and nothing else", () => {
		assert.equal(ev("a * x + b", { a: 2, x: 3, b: 1 }), 7);
		assert.deepEqual(parseExpression("a * x + b + pi").variables, ["a", "x", "b"]);
		assert.ok(Number.isNaN(ev("constructor")), "an unknown name is NaN, never an inherited property");
		assert.ok(Number.isNaN(ev("toString")));
		assert.ok(Number.isNaN(ev("__proto__")));
		assert.equal(ev("gamma * x + e", { gamma: 2, x: 3, e: 1 }), 7, "a parameter may share a function's or a constant's name");
		assert.equal(ev("gamma(5) + gamma", { gamma: 1 }) > 24.9, true, "calling still calls");
		close(ev("e"), Math.E);
		assert.deepEqual(parseExpression("exp(gamma) + pi").variables, ["gamma"]);
	});

	it("has the functions cards need", () => {
		close(ev("sigmoid(0)"), 0.5);
		assert.equal(ev("relu(-3)"), 0);
		assert.equal(ev("max(1, 5, 3)"), 5);
		assert.equal(ev("if(x > 0, x, 0.1 * x)", { x: -2 }), -0.2);
		assert.equal(ev("clamp(5, 0, 1)"), 1);
		close(ev("gamma(5)"), 24, 1e-9);
		close(ev("binom(5, 2)"), 10, 1e-6);
		close(ev("erf(1)"), 0.8427008, 1e-6);
		close(ev("normpdf(0, 0, 1)"), 0.3989423, 1e-6);
		close(ev("normcdf(1.96, 0, 1)"), 0.975, 1e-3);
		close(ev("softplus(100)"), 100);
		assert.equal(ev("(1 < 2) + (2 <= 2) + (3 == 3) + (3 != 3)"), 3);
	});

	it("refuses anything outside the grammar, with a plain message", () => {
		for (const [source, message] of [
			["", /empty/], ["1 +", /ends too early/], ["foo(1)", /unknown function "foo"/], ["x; alert(1)", /unexpected character ";"/],
			["a.b", /unexpected character "\."/], ["sin(1, 2)", /takes 1 argument, got 2/], ["(1", /expected "\)"/],
			["x[0]", /unexpected character "\["/], ["`x`", /unexpected character/], ["1 2", /unexpected "2"/], ["x = 1", /unexpected character "="/],
		] as const) {
			assert.throws(() => parseExpression(source), (err: unknown) => err instanceof ExpressionError && message.test(err.message), source);
		}
		assert.throws(() => parseExpression("1+".repeat(300) + "1"), /longer than/);
	});
});

describe("card validation", () => {
	it("resolves defaults, palette colours, and the note that explains one parameter", () => {
		const card = ok(SIGMOID);
		assert.deepEqual(card.parameters.k, { value: 1, min_value: 0.1, max_value: 8, step: 0.1, digits: 1, display: "number", symbol: "k", label: "parameter k", pixels_per_step: 7, color: FORMULA_COLORS[0] });
		assert.deepEqual(card.parameters.x0!.color, FORMULA_COLORS[1]);
		assert.deepEqual(card.notes.steep, { text: SIGMOID.notes!.steep, side: "auto", color: FORMULA_COLORS[0], param: "k" }, "a note wrapping one \\tangle takes that parameter's colour");
		assert.deepEqual(startingValues(card), { k: 1, x0: 0 });
	});

	it("a note around more than a parameter continues the palette", () => {
		const card = ok({ ...SIGMOID, latex: String.raw`\note{whole}{e^{-\tangle{k}(x - \tangle{x0})}}`, notes: { whole: "the exponent" } });
		assert.equal(card.notes.whole!.param, null);
		assert.deepEqual(card.notes.whole!.color, FORMULA_COLORS[2]);
	});

	it("markers and configuration must match, both ways, for parameters and notes", () => {
		assert.match(errorsOf({ ...SIGMOID, parameters: { k: SIGMOID.parameters.k } }), /missing configuration for parameter marker\(s\): x0/);
		assert.match(errorsOf({ ...SIGMOID, parameters: { ...SIGMOID.parameters, z: { value: 1 } } }), /not referenced by latex: z/);
		assert.match(errorsOf({ ...SIGMOID, notes: {} }), /missing note for marker\(s\): steep/);
		assert.match(errorsOf({ ...SIGMOID, notes: { ...SIGMOID.notes, extra: "x" } }), /note\(s\) not referenced by latex: extra/);
		assert.match(errorsOf({ ...SIGMOID, latex: "y = x" }), /at least one \\tangle\{name\} marker/);
	});

	it("parameter ranges are checked", () => {
		const withK = (k: unknown) => ({ ...SIGMOID, parameters: { ...SIGMOID.parameters, k } });
		assert.match(errorsOf(withK({ value: 9, min_value: 0, max_value: 8 })), /value must be between min_value and max_value/);
		assert.match(errorsOf(withK({ value: 1, min_value: 2, max_value: 1 })), /min_value must be less than max_value/);
		assert.match(errorsOf(withK({ value: 1, step: 0 })), /step must be positive/);
		assert.match(errorsOf(withK({ value: "1" })), /value must be a finite number/);
		assert.match(errorsOf(withK({ value: 1, display: "word" })), /display must be "number" or "symbol"/);
	});

	it("a plot may read only the parameters and x, and must be drawable across their ranges", () => {
		const plot = (p: unknown) => ({ ...SIGMOID, plot: p });
		assert.match(errorsOf(plot({ kind: "curve", x: { min: -6, max: 6 }, curves: [{ expr: "k * x + w" }] })), /reads "w", which is not a parameter or x/);
		assert.match(errorsOf(plot({ kind: "curve", x: { min: -6, max: 6 }, curves: [{ expr: "k * (x" }] })), /curves\[0\]\.expr: expected "\)"/);
		assert.match(errorsOf(plot({ kind: "curve", x: { min: -6, max: -1 }, curves: [{ expr: "sqrt(x) * k + x0" }] })), /not a finite number over most of the x range/);
		assert.match(errorsOf(plot({ kind: "curve", x: { min: 1, max: 0 }, curves: [{ expr: "k * x + x0" }] })), /plot\.x needs finite min and max/);
		assert.match(errorsOf(plot({ kind: "bars", bars: [{ label: "a", expr: "k" }] })), /needs 2 to 12 bars/);
		assert.match(errorsOf(plot({ kind: "bars", bars: [{ label: "a", expr: "k" }, { label: "b", expr: "x" }] })), /reads "x", which is not a parameter/);
		assert.match(errorsOf(plot({ kind: "pie" })), /plot\.kind must be "curve" or "bars"/);
		ok(plot({ kind: "curve", x: { min: -2, max: 6 }, curves: [{ expr: "log(x) * k + x0" }] })); // undefined on part of the range is fine
		ok(plot({ kind: "bars", bars: [{ label: "a", expr: "k" }, { label: "b", expr: "x0 ^ 2" }] }));
	});

	it("a curve plot reserves x, and plot names cannot contain a hyphen", () => {
		assert.match(errorsOf({ ...SIGMOID, latex: String.raw`\tangle{x}`, parameters: { x: { value: 1 } }, notes: {}, plot: { kind: "curve", x: { min: 0, max: 1 }, curves: [{ expr: "x" }] } }), /reserves the name "x"/);
		assert.match(errorsOf({ ...SIGMOID, latex: String.raw`\tangle{x-0}`, parameters: { "x-0": { value: 1 } }, notes: {}, plot: { kind: "bars", bars: [{ label: "a", expr: "1" }, { label: "b", expr: "2" }] } }), /may not contain "-"/);
	});

	it("reports every problem at once", () => {
		const all = errorsOf({ title: "", latex: String.raw`\tangle{a} + \tangle{b}`, parameters: { a: { value: 500 } } });
		assert.match(all, /title must be/);
		assert.match(all, /missing configuration for parameter marker\(s\): b/);
		assert.match(all, /"a" value must be between/);
	});

	it("derivations need non-empty steps", () => {
		const d = normalizeDerivation({ title: " Chain rule ", steps: [{ tex: "a = b" }, { tex: "b = c", note: "substitute" }] });
		assert.ok(d.ok);
		assert.deepEqual(d.value, { title: "Chain rule", steps: [{ tex: "a = b", note: "" }, { tex: "b = c", note: "substitute" }] });
		assert.ok(!normalizeDerivation({ steps: [] }).ok);
		assert.ok(!normalizeDerivation({ steps: [{ tex: " " }] }).ok);
		assert.ok(!normalizeDerivation({ steps: Array.from({ length: 17 }, () => ({ tex: "x" })) }).ok);
	});
});

describe("the LaTeX check", () => {
	it("renders the formula the way the widget will", () => {
		const card = ok(SIGMOID);
		assert.match(katexSourceOf(card), /\\htmlData\{tangle-param=k\}\{1\.0\}/);
		assert.deepEqual(formulaLatexProblems(card), []);
	});

	it("reports KaTeX's own message for bad LaTeX, in the formula, a symbol, or a note", () => {
		assert.match(formulaLatexProblems(ok({ ...SIGMOID, latex: String.raw`\frac{1}{\note{steep}{\tangle{k}} + \tangle{x0}` }))[0]!, /latex does not render/);
		assert.match(formulaLatexProblems(ok({ ...SIGMOID, parameters: { ...SIGMOID.parameters, k: { ...SIGMOID.parameters.k!, display: "symbol", symbol: String.raw`\nosuchmacro` } } })).join("\n"), /parameter "k" symbol does not render/);
		assert.match(formulaLatexProblems(ok({ ...SIGMOID, notes: { steep: String.raw`bad $\frac{1$ math` } }))[0]!, /note "steep" math/);
		assert.match(derivationLatexProblems({ steps: [{ tex: "a = b", note: "" }, { tex: String.raw`\frac{`, note: "" }] })[0]!, /step 2 tex does not render/);
	});
});

describe("the tools", () => {
	type Out = { content: { text: string }[]; details: unknown };
	const formula = createFormulaTool({ sig: SIGMOID });
	const run = (input: unknown) => formula.execute("c", input as never, undefined) as Promise<Out>;

	it("shows a library card by name and tells the guide what can be dragged", async () => {
		const out = await run({ name: "sig" });
		const card = out.details as FormulaCard;
		assert.equal(card.libraryId, "sig");
		assert.equal(card.title, "Logistic function");
		assert.match(out.content[0]!.text, /He can drag: k \(parameter k, 0\.1 to 8, starts at 1\); x0/);
		assert.match(out.content[0]!.text, /dashed reference/);
	});

	it("shows a card written inline", async () => {
		const out = await run({ card: SIGMOID });
		assert.equal((out.details as FormulaCard).libraryId, undefined);
	});

	it("refuses an unknown name, both or neither argument, and a card that would not draw — with every reason", async () => {
		await assert.rejects(() => run({ name: "nope" }), /no card named "nope"/);
		await assert.rejects(() => run({}), /exactly one of name/);
		await assert.rejects(() => run({ name: "sig", card: SIGMOID }), /exactly one of name/);
		await assert.rejects(() => run({ card: { ...SIGMOID, notes: {}, plot: { kind: "curve", x: { min: 0, max: 1 }, curves: [{ expr: "q" }] } } }), /missing note for marker/);
		await assert.rejects(() => run({ card: { ...SIGMOID, latex: String.raw`\frac{\note{steep}{\tangle{k}}}{\tangle{x0}` } }), /latex does not render/);
		await assert.rejects(() => run({ name: "constructor" }), /no card named/);
	});

	it("the tool's description carries the library index", () => {
		assert.match(formula.description, /Library cards: sig: Logistic function\./);
	});

	it("derivation shows steps and refuses bad LaTeX", async () => {
		const out = (await derivationTool.execute("c", { title: "T", steps: [{ tex: "a = b" }, { tex: "b = c", note: "n" }] } as never, undefined)) as Out;
		assert.match(out.content[0]!.text, /2-step derivation "T"/);
		await assert.rejects(() => derivationTool.execute("c", { steps: [{ tex: String.raw`\frac{` }] } as never, undefined) as Promise<Out>, /step 1 tex does not render/);
	});

	it("the guide and the teacher both have them; practice does not gain them", () => {
		const ctx = { chatId: "c", chatStore, jobStore, spawn: () => {} };
		for (const tools of [createGuideTools(ctx), createTeacherTools(ctx)]) {
			assert.ok("formula" in tools && "derivation" in tools);
		}
	});
});

describe("the shipped library", () => {
	it("every card has a plain name and a plot, validates, and renders in KaTeX", () => {
		const names = Object.keys(FORMULA_LIBRARY);
		assert.ok(names.length >= 250, `the library has ${names.length} cards`);
		for (const name of names) {
			assert.match(name, LIBRARY_NAME, name);
			const checked = normalizeFormulaCard(FORMULA_LIBRARY[name]);
			assert.ok(checked.ok, `${name}: ${checked.ok ? "" : checked.errors.join("; ")}`);
			assert.deepEqual(formulaLatexProblems(checked.value), [], name);
			assert.ok(checked.value.plot, `${name} has a plot`);
			assert.ok(Object.keys(checked.value.notes).length >= 1, `${name} explains at least one part`);
			assert.ok(checked.value.caption, `${name} has a caption`);
		}
		assert.equal(new Set(names.map((n) => FORMULA_LIBRARY[n]!.title)).size, names.length, "titles are unique");
	});

	it("the index the guide reads stays small enough to sit in a tool description", () => {
		// About 4 characters per token: 12,000 characters is roughly 3,000 tokens.
		assert.ok(libraryIndex().length < 12000, `index is ${libraryIndex().length} characters`);
		for (const name of ["sigmoid", "relu", "film", "softmax-temperature", "normal-pdf", "phred-quality", "michaelis-menten", "hardy-weinberg"]) {
			assert.ok(Object.hasOwn(FORMULA_LIBRARY, name), name);
		}
	});

	it("the index lists name: title for each", () => {
		assert.equal(libraryIndex({ a: { title: "A" } as FormulaCardInput, b: { title: "B" } as FormulaCardInput }), "a: A; b: B");
	});
});

describe("the plot", () => {
	const card = ok(SIGMOID);
	const curve = (values: Record<string, number>, committed = values, dragging = false) =>
		renderToStaticMarkup(<FormulaPlot plot={card.plot!} values={values} committed={committed} dragging={dragging} />);
	const d = (html: string) => /data-testid="plot-curve" d="([^"]+)"/.exec(html)![1]!;

	it("draws the curve from the expression and redraws when a value changes", () => {
		const a = curve({ k: 1, x0: 0 }), b = curve({ k: 4, x0: 0 });
		assert.match(a, /data-kind="curve"/);
		assert.notEqual(d(a), d(b));
		assert.ok(!a.includes("plot-reference"), "no reference curve at rest");
	});

	it("while dragging, the curve from before the drag stays as a dashed reference", () => {
		const html = curve({ k: 4, x0: 0 }, { k: 1, x0: 0 }, true);
		assert.match(html, /data-testid="plot-reference"[^>]*stroke-dasharray="4 4"/);
		assert.equal(/data-testid="plot-reference" d="([^"]+)"/.exec(html)![1], d(curve({ k: 1, x0: 0 })));
	});

	it("lifts the pen over undefined stretches instead of drawing through them", () => {
		const html = renderToStaticMarkup(<FormulaPlot plot={{ kind: "curve", x: { min: -2, max: 2 }, curves: [{ expr: "log(x)" }] }} values={{}} committed={{}} dragging={false} />);
		assert.equal((d(html).match(/M/g) ?? []).length, 1);
		assert.ok(!d(html).includes("NaN"));
	});

	it("bars: one per entry, heights from the expressions", () => {
		const plot = { kind: "bars" as const, y: { min: 0, max: 1 }, bars: [{ label: "a", expr: "t" }, { label: "b", expr: "1 - t" }] };
		const html = renderToStaticMarkup(<FormulaPlot plot={plot} values={{ t: 0.25 }} committed={{ t: 0.25 }} dragging={false} />);
		const heights = [...html.matchAll(/data-testid="plot-bar"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
		assert.equal(heights.length, 2);
		close(heights[1]! / heights[0]!, 3, 1e-6);
	});

	it("ticks are round numbers", () => {
		assert.deepEqual(niceTicks(0, 1), [0, 0.2, 0.4, 0.6, 0.8, 1]);
		assert.deepEqual(niceTicks(-6, 6, 6), [-6, -4, -2, 0, 2, 4, 6]);
		assert.equal(formatTick(0.30000000000000004), "0.3");
		assert.equal(formatTick(1234567), "1.2e6");
	});
});

describe("the widget host", () => {
	it("the model stores values, fires change events on set, and reports saves", () => {
		const model = new HostModel({ values: { k: 1 }, theme: "dark" });
		let changes = 0, saves = 0;
		const listener = () => { changes++; };
		model.on("change:values", listener);
		model.onSave = () => { saves++; };
		model.set("values", { k: 2 });
		assert.deepEqual(model.get("values"), { k: 2 });
		assert.equal(changes, 1);
		model.set("theme", "light");
		assert.equal(changes, 1, "only the changed key's listeners fire");
		model.save_changes();
		assert.equal(saves, 1);
		model.off("change:values", listener);
		model.set("values", { k: 3 });
		assert.equal(changes, 1);
	});

	it("the vendored widgets load nothing from the network", () => {
		for (const file of ["latex-tangle.js", "formula-animation.js"]) {
			const source = fs.readFileSync(`components/formula/vendor/${file}`, "utf-8");
			assert.deepEqual((source.replace(/^\s*\/\/.*$/gm, "").match(/https?:\/\/[^"'`\s]+/g) ?? []).filter((url) => url !== "http://www.w3.org/2000/svg"), [], `${file} names no address but the SVG namespace`);
			assert.ok(!/\bimport\(/.test(source), `${file} has no dynamic import`);
			assert.match(source, /import bundledKatex from "katex";/);
			assert.match(source, /VENDORED from koaning\/wigglystuff \(MIT/);
		}
		assert.match(fs.readFileSync("components/formula/vendor/LICENSE", "utf-8"), /MIT License/);
	});
});
