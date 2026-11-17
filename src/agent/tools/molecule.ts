import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { type MoleculeColor, type MoleculeDetails, type MoleculeStyle } from "../../core/contracts.ts";
import { summarizeStructure } from "../../core/structure-summary.ts";
import { chatRendersDir } from "../subagents/render-env.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { safeFetch } from "./safe-fetch.ts";

/**
 * papersplainer: molecule. Shows a molecular structure in the session as
 * an interactive 3D view (3Dmol.js, bundled with the app, nothing to
 * install). The tool only fetches or reads the structure file, saves a
 * copy with the session, and records how to draw it; the drawing happens
 * in the learner's window. Instant, model-free, like show_image.
 *
 * Contract: an unusable source fails the CALL with a clear message, so the
 * guide corrects it in the same turn.
 */

export const PDB_ID_RE = /^[0-9][A-Za-z0-9]{3}$/;
const FORMATS: Record<string, "pdb" | "cif"> = { ".pdb": "pdb", ".ent": "pdb", ".cif": "cif", ".mmcif": "cif" };
const MAX_STRUCTURE_BYTES = 60 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 90_000;

const moleculeInput = Type.Object({
	title: Type.String({ description: "Short title shown under the structure, e.g. 'Haemoglobin tetramer (4HHB)'." }),
	pdbId: Type.Optional(Type.String({ description: "A 4-character PDB ID named in the paper, e.g. 4HHB. Give this OR path, never both." })),
	path: Type.Optional(Type.String({ description: "Path to a structure file on the learner's computer (.pdb, .cif). Give this OR pdbId." })),
	style: Type.Optional(Type.Union([Type.Literal("cartoon"), Type.Literal("surface"), Type.Literal("sticks"), Type.Literal("ball_and_stick"), Type.Literal("spheres")], {
		description: "Representation. cartoon (default) for folds and secondary structure; surface for shape and pockets; sticks or ball_and_stick for small molecules and close-ups; spheres for packing.",
	})),
	color: Type.Optional(Type.Union([Type.Literal("chain"), Type.Literal("spectrum"), Type.Literal("secondary_structure"), Type.Literal("element"), Type.Literal("plddt")], {
		description: "chain (default): one colour per chain. spectrum: rainbow from N to C terminus. secondary_structure: helices, strands, loops. element: by atom type. plddt: AlphaFold confidence, only for predicted models.",
	})),
});

/** Why the input is unusable (null = fine). Pure. */
export function moleculeInputProblem(input: { pdbId?: unknown; path?: unknown }): string | null {
	const hasId = typeof input.pdbId === "string" && input.pdbId.trim() !== "";
	const hasPath = typeof input.path === "string" && input.path.trim() !== "";
	if (hasId === hasPath) return "give exactly one of pdbId (a 4-character PDB ID) or path (a structure file)";
	if (hasId && !PDB_ID_RE.test((input.pdbId as string).trim())) return `"${String(input.pdbId)}" is not a PDB ID (4 characters starting with a digit, e.g. 4HHB)`;
	if (hasPath && !(path.extname((input.path as string).trim()).toLowerCase() in FORMATS))
		return `the structure file must be one of ${Object.keys(FORMATS).join(", ")}`;
	return null;
}

async function fetchPdbEntry(id: string, signal?: AbortSignal): Promise<string> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const resp = await safeFetch(`https://files.rcsb.org/download/${id}.cif`, {
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (resp.status === 404) throw new Error(`PDB has no entry ${id}. Check the ID in the paper; do not guess another`);
	if (!resp.ok) throw new Error(`downloading PDB ${id} failed: HTTP ${resp.status}`);
	const bytes = new Uint8Array(await resp.arrayBuffer());
	if (bytes.length > MAX_STRUCTURE_BYTES) throw new Error(`PDB ${id} is larger than 60 MB, too large to show`);
	return Buffer.from(bytes).toString("utf-8");
}

function fileStem(toolCallId: string): string {
	const safe = toolCallId.replace(/[^A-Za-z0-9_-]/g, "").slice(-40);
	return `mol_${safe || Math.random().toString(36).slice(2, 10)}`;
}

export function createMoleculeTool(ctx: { chatId: string }): AgentTool<typeof moleculeInput> {
	return {
		name: "molecule",
		label: "molecule",
		description:
			"Show a molecular structure in the session as an interactive 3D view the learner can rotate and zoom. " +
			"Use it when the paper discusses a specific structure and gives its PDB ID, or the learner has a structure file. " +
			"Instant. You choose the representation and colouring. You do not see the structure yourself: the result is a " +
			"one-line summary (atoms, residues, chains).",
		parameters: moleculeInput,
		execute: serverExecute("molecule", moleculeInput, async (input, { toolCallId, signal }): Promise<ImageFileResult> => {
			const problem = moleculeInputProblem(input);
			if (problem) throw new Error(problem);
			const title = input.title.trim() || "Structure";
			// The schema's literals are checked against the shared lists by the type system here.
			const style: MoleculeStyle = input.style ?? "cartoon";
			const color: MoleculeColor = input.color ?? "chain";
			let text: string;
			let format: "pdb" | "cif";
			let source: string;
			if (input.pdbId?.trim()) {
				const id = input.pdbId.trim().toUpperCase();
				text = await fetchPdbEntry(id, signal);
				format = "cif";
				source = `PDB ${id}`;
			} else {
				const file = resolveSourcePath(input.path!.trim());
				const stat = await fs.stat(file);
				if (!stat.isFile()) throw new Error(`${file} is not a file`);
				if (stat.size > MAX_STRUCTURE_BYTES) throw new Error("the structure file is larger than 60 MB, too large to show");
				text = await fs.readFile(file, "utf-8");
				format = FORMATS[path.extname(file).toLowerCase()]!;
				source = file;
			}
			const summary = summarizeStructure(text, format);
			if (summary.atoms === 0) throw new Error(`no atoms found in ${source}; it does not look like a ${format === "pdb" ? "PDB" : "mmCIF"} structure file`);
			const dir = chatRendersDir(ctx.chatId);
			await fs.mkdir(dir, { recursive: true });
			const name = `${fileStem(toolCallId)}.${format}`;
			await fs.writeFile(path.join(dir, name), text);
			const details: MoleculeDetails = { title, file: name, format, style, color, source, ...summary };
			const chains = `${summary.chains.length} chain${summary.chains.length === 1 ? "" : "s"} (${summary.chains.slice(0, 12).join(", ")}${summary.chains.length > 12 ? ", …" : ""})`;
			return {
				text: `Shown to the learner as an interactive 3D view: ${source}, ${style.replace(/_/g, " ")} coloured by ${color.replace(/_/g, " ")}. ` +
					`${summary.atoms} atoms, ${summary.residues} residues, ${chains}; water not counted. You have not seen it yourself.`,
				details,
			};
		}),
	};
}
