/**
 * A small, safe arithmetic expression evaluator (papersplainer formula cards).
 *
 * A formula card's plot is described by expressions such as
 * `1 / (1 + exp(-k * (x - x0)))`. They are written by a model or shipped in
 * the card library, so they are NEVER handed to eval or Function: this file
 * parses them into a closure over a fixed grammar and a fixed function table.
 * An expression can read the names it is given and nothing else.
 *
 * Grammar (lowest to highest precedence):
 *   comparison  <  <=  >  >=  ==  !=      (result 1 or 0)
 *   additive    +  -
 *   term        *  /  %
 *   unary       -  +
 *   power       ^  (right associative, binds tighter than unary minus on its
 *                  left: -x^2 is -(x^2))
 *   atom        number | name | name(args) | ( expr )
 *
 * A name followed by "(" is a function call; any other name is a value read
 * from the scope (or the constant pi / e / inf when the scope has no such
 * entry). So a parameter may be called gamma or e without clashing.
 *
 * Pure: no I/O, no globals. Exported for the card validator, the plot and tests.
 */

export type Scope = Readonly<Record<string, number>>;
export type Compiled = (scope: Scope) => number;

export interface ParsedExpression {
	evaluate: Compiled;
	/** Every free name the expression reads (constants and functions excluded). */
	variables: string[];
}

export class ExpressionError extends Error {}

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E, inf: Number.POSITIVE_INFINITY };

// Lanczos approximation (g = 7, n = 9): accurate to ~1e-13 for the range plots use.
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(x: number): number {
	if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
	const z = x - 1;
	let a = LANCZOS[0]!;
	const t = z + 7.5;
	for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (z + i);
	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}
function gamma(x: number): number {
	if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
	return Math.exp(lgamma(x));
}
// Abramowitz and Stegun 7.1.26: |error| < 1.5e-7.
function erf(x: number): number {
	const sign = x < 0 ? -1 : 1;
	const a = Math.abs(x);
	const t = 1 / (1 + 0.3275911 * a);
	const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
	return sign * y;
}
function binom(n: number, k: number): number {
	if (k < 0 || k > n) return 0;
	return Math.exp(lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1));
}

/** name → [arity (or -1 for one-or-more), implementation]. */
const FUNCTIONS: Readonly<Record<string, readonly [number, (...args: number[]) => number]>> = {
	exp: [1, Math.exp], log: [1, Math.log], ln: [1, Math.log], log2: [1, Math.log2], log10: [1, Math.log10],
	sqrt: [1, Math.sqrt], abs: [1, Math.abs], sign: [1, Math.sign], floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round],
	sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan], asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan],
	sinh: [1, Math.sinh], cosh: [1, Math.cosh], tanh: [1, Math.tanh],
	pow: [2, Math.pow], atan2: [2, Math.atan2],
	min: [-1, Math.min], max: [-1, Math.max],
	sigmoid: [1, (x) => 1 / (1 + Math.exp(-x))],
	relu: [1, (x) => Math.max(0, x)],
	softplus: [1, (x) => (x > 30 ? x : Math.log1p(Math.exp(x)))],
	step: [1, (x) => (x >= 0 ? 1 : 0)],
	clamp: [3, (x, lo, hi) => Math.min(hi, Math.max(lo, x))],
	if: [3, (cond, a, b) => (cond !== 0 ? a : b)],
	erf: [1, erf], gamma: [1, gamma], lgamma: [1, lgamma], binom: [2, binom],
	normpdf: [3, (x, mu, sigma) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI))],
	normcdf: [3, (x, mu, sigma) => 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)))],
};

export const EXPRESSION_FUNCTIONS: readonly string[] = Object.keys(FUNCTIONS);
export const EXPRESSION_CONSTANTS: readonly string[] = Object.keys(CONSTANTS);

type Token = { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

const MAX_LENGTH = 400;

function tokenize(source: string): Token[] {
	if (source.length > MAX_LENGTH) throw new ExpressionError(`expression is longer than ${MAX_LENGTH} characters`);
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const c = source[i]!;
		if (/\s/.test(c)) { i++; continue; }
		const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
		if (number) { tokens.push({ kind: "num", value: Number(number[0]) }); i += number[0].length; continue; }
		const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
		if (name) { tokens.push({ kind: "name", value: name[0] }); i += name[0].length; continue; }
		const two = source.slice(i, i + 2);
		if (two === "<=" || two === ">=" || two === "==" || two === "!=" || two === "**") { tokens.push({ kind: "op", value: two === "**" ? "^" : two }); i += 2; continue; }
		if ("+-*/%^(),<>".includes(c)) { tokens.push({ kind: "op", value: c }); i++; continue; }
		throw new ExpressionError(`unexpected character "${c}" at position ${i + 1}`);
	}
	return tokens;
}

/** Parse once, evaluate many times. Throws ExpressionError with a plain
 *  message when the text is not an expression in the grammar above. */
export function parseExpression(source: string): ParsedExpression {
	if (typeof source !== "string" || source.trim() === "") throw new ExpressionError("expression is empty");
	const tokens = tokenize(source);
	const variables = new Set<string>();
	let at = 0;
	const peek = (): Token | undefined => tokens[at];
	const isOp = (value: string): boolean => { const t = tokens[at]; return t !== undefined && t.kind === "op" && t.value === value; };
	const take = (value: string): boolean => { if (isOp(value)) { at++; return true; } return false; };
	const expect = (value: string): void => { if (!take(value)) throw new ExpressionError(`expected "${value}"`); };

	function atom(): Compiled {
		const token = peek();
		if (!token) throw new ExpressionError("expression ends too early");
		at++;
		if (token.kind === "num") { const v = token.value; return () => v; }
		if (token.kind === "op" && token.value === "(") { const inner = comparison(); expect(")"); return inner; }
		if (token.kind !== "name") throw new ExpressionError(`unexpected "${token.value}"`);
		const name = token.value;
		if (take("(")) {
			const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name]! : null;
			if (!fn) throw new ExpressionError(`unknown function "${name}"`);
			const args: Compiled[] = [];
			if (!take(")")) {
				do args.push(comparison()); while (take(","));
				expect(")");
			}
			const [arity, impl] = fn;
			if (arity === -1 ? args.length === 0 : args.length !== arity) {
				throw new ExpressionError(`${name}() takes ${arity === -1 ? "at least one argument" : `${arity} argument${arity === 1 ? "" : "s"}`}, got ${args.length}`);
			}
			return (scope) => impl(...args.map((a) => a(scope)));
		}
		// A bare name is a value. A scope entry wins over a constant of the
		// same name, and a function's name is free to be a variable when it
		// is not being called (a parameter called gamma, beta or e is common).
		if (Object.hasOwn(CONSTANTS, name)) { const v = CONSTANTS[name]!; return (scope) => (Object.hasOwn(scope, name) ? scope[name]! : v); }
		variables.add(name);
		return (scope) => (Object.hasOwn(scope, name) ? scope[name]! : Number.NaN);
	}
	function power(): Compiled {
		const base = atom();
		if (take("^")) { const exponent = unary(); return (scope) => Math.pow(base(scope), exponent(scope)); }
		return base;
	}
	function unary(): Compiled {
		if (take("-")) { const operand = unary(); return (scope) => -operand(scope); }
		if (take("+")) return unary();
		return power();
	}
	function term(): Compiled {
		let left = unary();
		for (;;) {
			if (take("*")) { const l = left, r = unary(); left = (s) => l(s) * r(s); }
			else if (take("/")) { const l = left, r = unary(); left = (s) => l(s) / r(s); }
			else if (take("%")) { const l = left, r = unary(); left = (s) => l(s) % r(s); }
			else return left;
		}
	}
	function additive(): Compiled {
		let left = term();
		for (;;) {
			if (take("+")) { const l = left, r = term(); left = (s) => l(s) + r(s); }
			else if (take("-")) { const l = left, r = term(); left = (s) => l(s) - r(s); }
			else return left;
		}
	}
	function comparison(): Compiled {
		const left = additive();
		const token = peek();
		if (token?.kind === "op" && ["<", "<=", ">", ">=", "==", "!="].includes(token.value)) {
			at++;
			const right = additive();
			const op = token.value;
			return (s) => {
				const a = left(s), b = right(s);
				const yes = op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "==" ? a === b : a !== b;
				return yes ? 1 : 0;
			};
		}
		return left;
	}

	const evaluate = comparison();
	if (at < tokens.length) throw new ExpressionError(`unexpected "${String(tokens[at]!.value)}"`);
	return { evaluate, variables: [...variables] };
}
