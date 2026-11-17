import type { MoleculeColor, MoleculeStyle } from "@/src/core";

/**
 * papersplainer: maps the molecule tool's style + colour choice onto
 * 3Dmol.js style objects. Pure, so it is tested without a browser.
 */

type ColorOptions = Record<string, unknown>;

export interface MoleculeViewSpec {
	/** Passed to viewer.setStyle({}, atomStyle). */
	atomStyle: Record<string, ColorOptions>;
	/** Present for the surface style: passed to viewer.addSurface. */
	surface?: ColorOptions;
}

/** Colour options for one representation. `cartoon` supports the library's
 *  own N-to-C "spectrum"; other representations get a residue-number gradient. */
function colorOptions(color: MoleculeColor, cartoon: boolean, residueRange: { min: number; max: number }): ColorOptions {
	switch (color) {
		case "chain":
			return { colorscheme: "chain" };
		case "element":
			return { colorscheme: "default" };
		case "secondary_structure":
			return { colorscheme: "ssJmol" };
		case "plddt":
			// AlphaFold stores per-residue confidence (0 to 100) in the B-factor column.
			return { colorscheme: { prop: "b", gradient: "roygb", min: 50, max: 90 } };
		case "spectrum":
			return cartoon
				? { color: "spectrum" }
				: { colorscheme: { prop: "resi", gradient: "sinebow", min: residueRange.min, max: residueRange.max } };
	}
}

export function moleculeViewSpec(
	style: MoleculeStyle,
	color: MoleculeColor,
	residueRange: { min: number; max: number } = { min: 1, max: 1 },
): MoleculeViewSpec {
	const flat = colorOptions(color, false, residueRange);
	switch (style) {
		case "cartoon":
			return { atomStyle: { cartoon: colorOptions(color, true, residueRange) } };
		case "sticks":
			return { atomStyle: { stick: { ...flat, radius: 0.2 } } };
		case "ball_and_stick":
			return { atomStyle: { stick: { ...flat, radius: 0.15 }, sphere: { ...flat, scale: 0.3 } } };
		case "spheres":
			return { atomStyle: { sphere: flat } };
		case "surface":
			// A faint cartoon underneath keeps the fold readable through the surface.
			return { atomStyle: { cartoon: { ...colorOptions(color, true, residueRange), opacity: 0.5 } }, surface: { ...flat, opacity: 0.85 } };
	}
}
