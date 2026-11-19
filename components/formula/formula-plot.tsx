/**
 * The plot linked to a formula card: curves or bars computed from the
 * card's expressions (core/expr.ts) at the current parameter values. While a
 * parameter is being dragged, the curve from before the drag stays as a
 * dashed reference. Pure SVG, a pure function of its props (exported for
 * render tests); no chart library.
 */

import { useMemo } from "react";
import { PLOT_SAMPLES, parseExpression, type Compiled, type FormulaPlotInput } from "@/src/core";

const W = 560, H = 240, M = { top: 12, right: 14, bottom: 34, left: 46 };
const IW = W - M.left - M.right, IH = H - M.top - M.bottom;
/** Second and later curves take the card palette's later colours, so the
 *  first curve stays the neutral ink. */
const CURVE_COLORS = ["currentColor", "#b45b1b", "#147a68", "#a23b78"];

/** Up to ~5 round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
	if (!(max > min)) return [min];
	const raw = (max - min) / count;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
	const ticks: number[] = [];
	for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
	return ticks;
}

export function formatTick(value: number): string {
	if (value === 0) return "0";
	const abs = Math.abs(value);
	if (abs >= 10000 || abs < 0.001) return value.toExponential(1).replace("e+", "e");
	return String(Number(value.toPrecision(3)));
}

function compileAll(exprs: readonly string[]): (Compiled | null)[] {
	return exprs.map((expr) => {
		try { return parseExpression(expr).evaluate; } catch { return null; }
	});
}

function sample(f: Compiled | null, scope: Record<string, number>, x0: number, x1: number): (number | null)[] {
	const out: (number | null)[] = [];
	for (let i = 0; i < PLOT_SAMPLES; i++) {
		const y = f ? f({ ...scope, x: x0 + (x1 - x0) * (i / (PLOT_SAMPLES - 1)) }) : Number.NaN;
		out.push(Number.isFinite(y) ? y : null);
	}
	return out;
}

/** The y range to draw: the card's fixed bounds where given, else the data's
 *  own extent with a little air (and never a zero-height range). */
function yRange(values: readonly (number | null)[], axis: { min?: number; max?: number } | undefined, includeZero: boolean): [number, number] {
	const nums = values.filter((v): v is number => v !== null);
	let lo = nums.length ? Math.min(...nums) : 0, hi = nums.length ? Math.max(...nums) : 1;
	if (includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
	if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
	const pad = (hi - lo) * 0.06;
	return [axis?.min ?? lo - (includeZero && lo === 0 ? 0 : pad), axis?.max ?? hi + pad];
}

/** A polyline path that lifts the pen over gaps and clips far-off values. */
function linePath(ys: readonly (number | null)[], sy: (y: number) => number): string {
	let d = "", pen = false;
	ys.forEach((y, i) => {
		if (y === null) { pen = false; return; }
		const px = M.left + (IW * i) / (PLOT_SAMPLES - 1);
		const py = Math.max(-H, Math.min(2 * H, sy(y)));
		d += `${pen ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
		pen = true;
	});
	return d;
}

export function FormulaPlot({
	plot,
	values,
	committed,
	dragging,
}: {
	plot: FormulaPlotInput;
	/** The parameters now. */
	values: Record<string, number>;
	/** The parameters before the current drag. */
	committed: Record<string, number>;
	dragging: boolean;
}) {
	const exprs = plot.kind === "curve" ? plot.curves.map((c) => c.expr) : plot.bars.map((b) => b.expr);
	const compiled = useMemo(() => compileAll(exprs), [exprs.join("\n")]);
	const frame = (
		<>
			<line x1={M.left} y1={M.top + IH} x2={M.left + IW} y2={M.top + IH} stroke="currentColor" strokeOpacity={0.35} />
			<line x1={M.left} y1={M.top} x2={M.left} y2={M.top + IH} stroke="currentColor" strokeOpacity={0.35} />
		</>
	);
	const yTicks = (lo: number, hi: number, sy: (y: number) => number) =>
		niceTicks(lo, hi).map((t) => (
			<g key={t}>
				<line x1={M.left} x2={M.left + IW} y1={sy(t)} y2={sy(t)} stroke="currentColor" strokeOpacity={t === 0 ? 0.35 : 0.09} />
				<text x={M.left - 6} y={sy(t)} textAnchor="end" dominantBaseline="central" fontSize={11} fill="currentColor" fillOpacity={0.6}>{formatTick(t)}</text>
			</g>
		));

	if (plot.kind === "curve") {
		const { min: x0, max: x1 } = plot.x;
		const now = compiled.map((f) => sample(f, values, x0, x1));
		const before = dragging ? compiled.map((f) => sample(f, committed, x0, x1)) : [];
		const [lo, hi] = yRange([...now.flat(), ...before.flat()], plot.y, false);
		const sy = (y: number) => M.top + IH - ((y - lo) / (hi - lo)) * IH;
		const sx = (x: number) => M.left + ((x - x0) / (x1 - x0)) * IW;
		const labelled = plot.curves.filter((c) => c.label);
		return (
			<figure data-testid="formula-plot" data-kind="curve" className="m-0 text-foreground">
				<svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Plot of ${plot.curves.map((c) => c.label ?? c.expr).join(", ")}`}>
					{yTicks(lo, hi, sy)}
					{niceTicks(x0, x1, 6).map((t) => (
						<text key={t} x={sx(t)} y={M.top + IH + 16} textAnchor="middle" fontSize={11} fill="currentColor" fillOpacity={0.6}>{formatTick(t)}</text>
					))}
					{frame}
					{before.map((ys, i) => (
						<path key={`b${i}`} data-testid="plot-reference" d={linePath(ys, sy)} fill="none" stroke={CURVE_COLORS[i % CURVE_COLORS.length]} strokeOpacity={0.45} strokeWidth={1.5} strokeDasharray="4 4" />
					))}
					{now.map((ys, i) => (
						<path key={i} data-testid="plot-curve" d={linePath(ys, sy)} fill="none" stroke={CURVE_COLORS[i % CURVE_COLORS.length]} strokeWidth={2} strokeLinejoin="round" />
					))}
					{plot.x.label && <text x={M.left + IW} y={H - 3} textAnchor="end" fontSize={11} fill="currentColor" fillOpacity={0.6}>{plot.x.label}</text>}
					{plot.y?.label && <text x={M.left + 6} y={M.top + 9} fontSize={11} fill="currentColor" fillOpacity={0.6}>{plot.y.label}</text>}
				</svg>
				{labelled.length > 0 && (
					<figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
						{plot.curves.map((c, i) => c.label && (
							<span key={i} className="inline-flex items-center gap-1.5">
								<span aria-hidden className="inline-block h-0.5 w-4" style={{ background: CURVE_COLORS[i % CURVE_COLORS.length] }} />
								{c.label}
							</span>
						))}
					</figcaption>
				)}
			</figure>
		);
	}

	const heights = compiled.map((f) => { const v = f ? f(values) : Number.NaN; return Number.isFinite(v) ? v : null; });
	const beforeHeights = dragging ? compiled.map((f) => { const v = f ? f(committed) : Number.NaN; return Number.isFinite(v) ? v : null; }) : [];
	const [lo, hi] = yRange([...heights, ...beforeHeights], plot.y, true);
	const sy = (y: number) => M.top + IH - ((y - lo) / (hi - lo)) * IH;
	const slot = IW / plot.bars.length, bw = Math.min(56, slot * 0.6);
	return (
		<figure data-testid="formula-plot" data-kind="bars" className="m-0 text-foreground">
			<svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Bar chart of ${plot.bars.map((b) => b.label).join(", ")}`}>
				{yTicks(lo, hi, sy)}
				{frame}
				{plot.bars.map((bar, i) => {
					const cx = M.left + slot * (i + 0.5);
					const h = heights[i], b = beforeHeights[i];
					return (
						<g key={i}>
							{h !== null && h !== undefined && <rect data-testid="plot-bar" x={cx - bw / 2} width={bw} y={Math.min(sy(h), sy(0))} height={Math.max(1, Math.abs(sy(h) - sy(0)))} rx={2} fill="currentColor" fillOpacity={0.8} />}
							{b !== null && b !== undefined && <line data-testid="plot-reference" x1={cx - bw / 2 - 3} x2={cx + bw / 2 + 3} y1={sy(b)} y2={sy(b)} stroke="currentColor" strokeOpacity={0.6} strokeDasharray="4 3" />}
							<text x={cx} y={M.top + IH + 16} textAnchor="middle" fontSize={11} fill="currentColor" fillOpacity={0.7}>{bar.label}</text>
						</g>
					);
				})}
				{plot.y?.label && <text x={M.left + 6} y={M.top + 9} fontSize={11} fill="currentColor" fillOpacity={0.6}>{plot.y.label}</text>}
			</svg>
		</figure>
	);
}
