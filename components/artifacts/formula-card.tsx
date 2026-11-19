"use client";

/**
 * papersplainer: the `formula` and `derivation` tool results in the
 * transcript.
 *
 * FormulaCard — an annotated formula whose coloured numbers are dragged in
 * place (the vendored TangleLatex front end), over a plot that redraws from
 * the card's expressions as they move. DerivationCard — a derivation stepped
 * through one line at a time (the vendored FormulaAnimation front end).
 * Both are data in, picture out: nothing a model wrote is executed.
 *
 * Their stylesheets (the vendored ones and formula.css) are imported once in
 * app/layout.tsx, beside KaTeX's.
 */

import { useCallback, useState } from "react";
import { startingValues, type ArtifactPartProps, type Derivation, type FormulaCard as FormulaCardData } from "@/src/core";
import { FormulaPlot } from "@/components/formula/formula-plot";
import { WidgetHost, type HostModel } from "@/components/formula/widget-host";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";

const loadTangle = () => import("@/components/formula/vendor/latex-tangle.js");
const loadAnimation = () => import("@/components/formula/vendor/formula-animation.js");

function isFormulaCard(value: unknown): value is FormulaCardData {
	const v = value as Partial<FormulaCardData> | null;
	return !!v && typeof v === "object" && typeof v.latex === "string" && typeof v.title === "string"
		&& typeof v.parameters === "object" && v.parameters !== null && typeof v.notes === "object" && v.notes !== null;
}

function isDerivation(value: unknown): value is Derivation {
	const v = value as Partial<Derivation> | null;
	return !!v && typeof v === "object" && Array.isArray(v.steps) && v.steps.length > 0 && v.steps.every((s) => typeof s?.tex === "string");
}

const FRAME = "pp-formula my-4 overflow-hidden rounded-xl border border-border bg-card";

/** The card itself; exported for render tests and the library preview. */
export function FormulaCardView({ card }: { card: FormulaCardData }) {
	const [live, setLive] = useState(() => ({ values: startingValues(card), committed: startingValues(card), dragging: false }));
	const read = useCallback((model: HostModel) => {
		setLive({
			values: { ...(model.get("values") as Record<string, number>) },
			committed: { ...(model.get("committed_values") as Record<string, number>) },
			dragging: model.get("dragging") === true,
		});
	}, []);
	return (
		<figure data-testid="formula-card" className={FRAME}>
			<figcaption className="flex items-baseline justify-between gap-4 px-4 pt-3">
				<span className="text-sm font-medium text-foreground">{card.title}</span>
				<span className="shrink-0 text-xs text-muted-foreground">Drag a coloured value</span>
			</figcaption>
			<WidgetHost
				testid="formula-widget"
				load={loadTangle}
				configKey={JSON.stringify([card.latex, card.parameters, card.notes])}
				config={{
					latex: card.latex,
					parameters: card.parameters,
					notes: card.notes,
					values: startingValues(card),
					committed_values: startingValues(card),
					dragging: false,
					display_mode: true,
					editor: "popover",
					reveal_all_on_drag: false,
					hovered: "",
					error: "",
				}}
				onSave={read}
			/>
			{card.plot && (
				<div className="border-t border-border/60 px-4 pb-3 pt-3">
					<FormulaPlot plot={card.plot} values={live.values} committed={live.committed} dragging={live.dragging} />
				</div>
			)}
			{card.caption && <p className="border-t border-border/60 px-4 py-2.5 font-prose text-sm text-muted-foreground">{card.caption}</p>}
		</figure>
	);
}

export function DerivationCardView({ derivation }: { derivation: Derivation }) {
	return (
		<figure data-testid="derivation-card" className={FRAME}>
			<WidgetHost
				testid="derivation-widget"
				load={loadAnimation}
				configKey={JSON.stringify(derivation)}
				config={{ steps: derivation.steps, title: derivation.title ?? null, spotlight: true, step: 0, height: 320, error: "" }}
			/>
		</figure>
	);
}

export function FormulaCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available" || !isFormulaCard(part.output)) return <ToolCallCard part={part} />;
	return <FormulaCardView card={part.output} />;
}

export function DerivationCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available" || !isDerivation(part.output)) return <ToolCallCard part={part} />;
	return <DerivationCardView derivation={part.output} />;
}
