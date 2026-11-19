/**
 * Formula library: machine learning and reinforcement learning building
 * blocks. Plain data (see ./library.ts); LaTeX is written with String.raw so
 * backslashes are literal.
 */
import type { FormulaCardInput } from "../../core/formula.ts";

export const ML_CARDS: Record<string, FormulaCardInput> = {
	sigmoid: {
		title: "Logistic (sigmoid) function",
		caption: "The steepness sets how sharply the output switches from 0 to 1; the midpoint sets where.",
		latex: String.raw`\sigma(x) = \frac{1}{1 + e^{-\note{steep}{\tangle{k}}\,(x - \note{mid}{\tangle{x0}})}}`,
		parameters: {
			k: { value: 1, min_value: 0.1, max_value: 8, step: 0.1, digits: 1, label: "steepness" },
			x0: { value: 0, min_value: -4, max_value: 4, step: 0.1, digits: 1, label: "midpoint" },
		},
		notes: { steep: "**steepness**: larger means a sharper switch", mid: "**midpoint**: where the output is $0.5$" },
		plot: { kind: "curve", x: { label: "x", min: -6, max: 6 }, y: { min: 0, max: 1 }, curves: [{ expr: "1 / (1 + exp(-k * (x - x0)))", label: "σ(x)" }] },
	},
	relu: {
		title: "ReLU and leaky ReLU",
		caption: "ReLU passes positive inputs unchanged and zeroes the rest; a small negative slope keeps a gradient alive below zero.",
		latex: String.raw`f(x) = \max\bigl(\note{leak}{\tangle{a}}\,x,\; x\bigr)`,
		parameters: { a: { value: 0, min_value: 0, max_value: 0.5, step: 0.01, digits: 2, label: "negative slope" } },
		notes: { leak: "**negative slope**: $0$ is plain ReLU, above $0$ is leaky ReLU" },
		plot: { kind: "curve", x: { label: "x", min: -4, max: 4 }, y: { min: -2, max: 4 }, curves: [{ expr: "max(a * x, x)", label: "f(x)" }] },
	},
	"softmax-temperature": {
		title: "Softmax with temperature",
		caption: "Dividing the logits by a temperature below 1 sharpens the distribution; above 1 flattens it toward uniform.",
		latex: String.raw`p_i = \frac{e^{z_i / \note{temp}{\tangle{T}}}}{\sum_j e^{z_j / \tangle{T}}}`,
		parameters: { T: { value: 1, min_value: 0.1, max_value: 5, step: 0.1, digits: 1, label: "temperature" } },
		notes: { temp: "**temperature**: low sharpens, high flattens" },
		plot: {
			kind: "bars",
			y: { label: "probability", min: 0, max: 1 },
			bars: [
				{ label: "z = 2", expr: "exp(2 / T) / (exp(2 / T) + exp(1 / T) + exp(0.5 / T) + exp(-1 / T))" },
				{ label: "z = 1", expr: "exp(1 / T) / (exp(2 / T) + exp(1 / T) + exp(0.5 / T) + exp(-1 / T))" },
				{ label: "z = 0.5", expr: "exp(0.5 / T) / (exp(2 / T) + exp(1 / T) + exp(0.5 / T) + exp(-1 / T))" },
				{ label: "z = −1", expr: "exp(-1 / T) / (exp(2 / T) + exp(1 / T) + exp(0.5 / T) + exp(-1 / T))" },
			],
		},
	},
	film: {
		title: "FiLM: feature-wise linear modulation",
		caption: "A conditioning network outputs a scale and a shift per feature; the feature is stretched and moved, then passed through the nonlinearity.",
		latex: String.raw`\operatorname{FiLM}(x) = \operatorname{ReLU}\bigl(\note{scale}{\tangle{gamma}}\,x + \note{shift}{\tangle{beta}}\bigr)`,
		parameters: {
			gamma: { value: 1, min_value: -3, max_value: 3, step: 0.1, digits: 1, display: "symbol", symbol: String.raw`\gamma`, label: "scale" },
			beta: { value: 0, min_value: -3, max_value: 3, step: 0.1, digits: 1, display: "symbol", symbol: String.raw`\beta`, label: "shift" },
		},
		notes: {
			scale: String.raw`**scale** $\gamma$: set by the conditioning input; negative flips the feature`,
			shift: String.raw`**shift** $\beta$: moves where the feature switches on`,
		},
		plot: {
			kind: "curve",
			x: { label: "feature x", min: -4, max: 4 },
			y: { min: -1, max: 6 },
			curves: [{ expr: "max(0, gamma * x + beta)", label: "FiLM(x)" }, { expr: "max(0, x)", label: "unmodulated ReLU(x)" }],
		},
	},
};
