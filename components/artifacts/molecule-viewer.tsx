"use client";

import { useEffect, useRef, useState } from "react";
import type { MoleculeColor, MoleculeStyle } from "@/src/core";
import { moleculeViewSpec } from "@/components/artifacts/molecule-style";

/**
 * papersplainer: the interactive structure view (3Dmol.js, WebGL). The
 * library is loaded on demand, in the browser only, the first time a
 * structure is shown. Drag rotates, scroll zooms.
 */
export function MoleculeViewer({
	url,
	format,
	style,
	color,
	label,
}: {
	url: string;
	format: "pdb" | "cif";
	style: MoleculeStyle;
	color: MoleculeColor;
	label: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
	const [reason, setReason] = useState("");

	useEffect(() => {
		const element = host.current;
		if (!element) return;
		let cancelled = false;
		let viewer: { clear: () => void } | null = null;
		setState("loading");
		void (async () => {
			try {
				const [lib, response] = await Promise.all([import("3dmol"), fetch(url, { cache: "force-cache" })]);
				if (!response.ok) throw new Error(`the structure file could not be loaded (HTTP ${response.status})`);
				const data = await response.text();
				if (cancelled) return;
				const view = lib.createViewer(element, { backgroundAlpha: 0 });
				if (!view) throw new Error("3D graphics (WebGL) are not available in this window");
				viewer = view;
				view.addModel(data, format);
				const residues = view.selectedAtoms({}).map((atom) => atom.resi).filter((n): n is number => typeof n === "number");
				const range = residues.length ? { min: Math.min(...residues), max: Math.max(...residues) } : { min: 1, max: 1 };
				const spec = moleculeViewSpec(style, color, range);
				view.setStyle({}, spec.atomStyle);
				if (spec.surface) void view.addSurface(lib.SurfaceType.VDW, spec.surface, {});
				view.zoomTo();
				view.render();
				setState("ready");
			} catch (err) {
				if (cancelled) return;
				setReason(err instanceof Error ? err.message : String(err));
				setState("failed");
			}
		})();
		return () => {
			cancelled = true;
			try { viewer?.clear(); } catch { /* the canvas is going away anyway */ }
			element.replaceChildren();
		};
	}, [url, format, style, color]);

	return (
		<div className="relative h-[420px] w-full overflow-hidden rounded-lg border bg-card" data-testid="molecule-viewer" data-state={state}>
			<div ref={host} role="img" aria-label={label} className="absolute inset-0" />
			{state !== "ready" && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground" role="status">
					{state === "loading" ? "Loading structure…" : `The structure could not be shown: ${reason}`}
				</div>
			)}
		</div>
	);
}
