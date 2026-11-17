import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";
import { MOLECULE_COLORS, MOLECULE_STYLES, type MoleculeColor, type MoleculeResult, type MoleculeStyle } from "../../core/contracts.ts";
import { ensureRenderEnv, runProcess, tail } from "./render-env.ts";

/**
 * papersplainer: the molecule render. One still image of a structure,
 * drawn by Molecular Nodes inside Blender's Python module (bpy) and
 * rendered on the CPU with Cycles. Deterministic: no model call. The
 * script below is fixed; only a validated JSON spec varies.
 */

export interface MoleculeRenderInput {
	title: string;
	/** Exactly one of pdbId / file. */
	pdbId?: string;
	/** Absolute path of a structure file (already checked against file access). */
	file?: string;
	style?: MoleculeStyle;
	color?: MoleculeColor;
}

export interface MoleculeRenderOptions {
	/** Where the png is written (absolute path). */
	outputPath: string;
	onActivity?: (line: string) => void;
	abortSignal?: AbortSignal;
	/** Test seam: replaces the Blender run. Receives the spec, writes spec.out, returns the script's JSON line. */
	run?: (spec: MoleculeSpec, signal?: AbortSignal) => Promise<MoleculeSummary>;
}

export interface MoleculeSpec {
	pdbId: string | null;
	file: string | null;
	style: MoleculeStyle;
	color: MoleculeColor;
	out: string;
	cache: string;
}

export interface MoleculeSummary {
	atoms: number;
	residues: number;
	chains: string[];
}

export const PDB_ID_RE = /^[0-9][A-Za-z0-9]{3}$/;
const STRUCTURE_EXTENSIONS = [".pdb", ".cif", ".mmcif", ".bcif", ".pdbx"];

/** Validate the tool input; returns the problem text or null. */
export function moleculeInputProblem(input: { pdbId?: unknown; path?: unknown; style?: unknown; color?: unknown }): string | null {
	const hasId = typeof input.pdbId === "string" && input.pdbId.trim() !== "";
	const hasPath = typeof input.path === "string" && input.path.trim() !== "";
	if (hasId === hasPath) return "give exactly one of pdbId (a 4-character PDB ID) or path (a structure file)";
	if (hasId && !PDB_ID_RE.test((input.pdbId as string).trim())) return `"${String(input.pdbId)}" is not a PDB ID (4 characters, starting with a digit, e.g. 4HHB)`;
	if (hasPath && !STRUCTURE_EXTENSIONS.includes(path.extname((input.path as string).trim()).toLowerCase()))
		return `the structure file must be one of ${STRUCTURE_EXTENSIONS.join(", ")}`;
	if (input.style !== undefined && !(MOLECULE_STYLES as readonly unknown[]).includes(input.style)) return `style must be one of ${MOLECULE_STYLES.join(", ")}`;
	if (input.color !== undefined && !(MOLECULE_COLORS as readonly unknown[]).includes(input.color)) return `color must be one of ${MOLECULE_COLORS.join(", ")}`;
	return null;
}

const RENDER_SCRIPT = `
import json, sys
import numpy as np
import bpy
import molecularnodes as mn

spec = json.load(open(sys.argv[1]))
canvas = mn.Canvas(engine="CYCLES", resolution=(1280, 720))
scene = bpy.context.scene
scene.cycles.device = "CPU"
scene.cycles.samples = 32
if spec["pdbId"]:
    mol = mn.Molecule.fetch(spec["pdbId"], cache=spec["cache"])
else:
    mol = mn.Molecule.load(spec["file"])
mol.add_style(spec["style"], color=spec["color"])
canvas.frame_object(mol)
canvas.snapshot(spec["out"])
arr = mol.array
if hasattr(arr, "stack_depth"):
    arr = arr[0]
chains = [str(c) for c in dict.fromkeys(arr.chain_id.tolist())]
residues = len(set(zip(arr.chain_id.tolist(), arr.res_id.tolist())))
print("PAPERSPLAINER_RESULT " + json.dumps({"atoms": int(arr.array_length()), "residues": residues, "chains": chains}))
`;

async function runBlender(spec: MoleculeSpec, onActivity: (line: string) => void, signal?: AbortSignal): Promise<MoleculeSummary> {
	const python = await ensureRenderEnv("molecule", onActivity, signal);
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-molecule-"));
	try {
		await fs.writeFile(path.join(dir, "render.py"), RENDER_SCRIPT);
		await fs.writeFile(path.join(dir, "spec.json"), JSON.stringify(spec));
		onActivity(spec.pdbId ? `rendering PDB ${spec.pdbId}` : "rendering structure");
		const run = await runProcess(python, [path.join(dir, "render.py"), path.join(dir, "spec.json")], { cwd: dir, signal, timeoutMs: 15 * 60_000 });
		if (run.timedOut) throw new Error("the render timed out (15 minutes)");
		const line = run.stdout.split("\n").find((l) => l.startsWith("PAPERSPLAINER_RESULT "));
		if (run.code !== 0 || !line) throw new Error(tail(pythonError(run.stderr) || run.stdout || "Blender exited without a result", 1500));
		return JSON.parse(line.slice("PAPERSPLAINER_RESULT ".length)) as MoleculeSummary;
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/** Blender prints a lot of device noise on stderr; keep the Python traceback when there is one. */
function pythonError(stderr: string): string {
	const at = stderr.lastIndexOf("Traceback (most recent call last)");
	return at >= 0 ? stderr.slice(at) : stderr;
}

export async function renderMolecule(input: MoleculeRenderInput, opts: MoleculeRenderOptions): Promise<MoleculeResult> {
	const title = input.title.trim() || "Structure";
	const pdbId = input.pdbId?.trim().toUpperCase() || null;
	const source = pdbId ? `PDB ${pdbId}` : (input.file ?? "");
	const failed = (reason: string): MoleculeResult => ({ title, file: "", source, notes: `FAILED: ${reason}` });
	const style = input.style ?? "cartoon";
	const color = input.color ?? "common";
	try {
		await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
		const cache = path.join(PATHS.renderEnv, "structure-cache");
		await fs.mkdir(cache, { recursive: true });
		const spec: MoleculeSpec = { pdbId, file: pdbId ? null : (input.file ?? null), style, color, out: opts.outputPath, cache };
		const summary = opts.run
			? await opts.run(spec, opts.abortSignal)
			: await runBlender(spec, opts.onActivity ?? (() => {}), opts.abortSignal);
		await fs.access(opts.outputPath);
		return {
			title,
			file: path.basename(opts.outputPath),
			source,
			notes: `${source}, drawn as ${style.replace(/_/g, " ")} with ${color === "plddt" ? "pLDDT confidence" : "element/chain"} colouring. ` +
				`${summary.atoms} atoms, ${summary.residues} residues, ${summary.chains.length} chain${summary.chains.length === 1 ? "" : "s"} (${summary.chains.slice(0, 12).join(", ")}${summary.chains.length > 12 ? ", …" : ""}). Solvent removed.`,
		};
	} catch (err) {
		if (opts.abortSignal?.aborted) throw err;
		return failed(err instanceof Error ? err.message : String(err));
	}
}
