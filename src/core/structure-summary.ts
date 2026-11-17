/**
 * papersplainer: a small, pure reader for molecular structure files. It
 * counts what a structure contains (atoms, residues, chains) so the guide
 * can describe the molecule it is showing without seeing it. First model
 * only; water is not counted. Not a validating parser.
 */

export interface StructureSummary {
	atoms: number;
	residues: number;
	chains: string[];
}

const WATER = new Set(["HOH", "WAT", "DOD", "H2O"]);

export function summarizePdb(text: string): StructureSummary {
	const chains: string[] = [];
	const residues = new Set<string>();
	let atoms = 0;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("ENDMDL")) break;
		if (!line.startsWith("ATOM") && !line.startsWith("HETATM")) continue;
		const residue = line.slice(17, 20).trim();
		if (WATER.has(residue)) continue;
		const chain = line.slice(21, 22).trim() || "-";
		atoms++;
		if (!chains.includes(chain)) chains.push(chain);
		residues.add(`${chain}/${line.slice(22, 27).trim()}`);
	}
	return { atoms, residues: residues.size, chains };
}

/** Split one mmCIF data row into tokens (whitespace-separated; quoted values kept whole). */
function cifTokens(line: string): string[] {
	const tokens: string[] = [];
	const re = /'((?:[^']|'(?=\S))*)'|"((?:[^"]|"(?=\S))*)"|(\S+)/g;
	for (let m = re.exec(line); m; m = re.exec(line)) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
	return tokens;
}

export function summarizeCif(text: string): StructureSummary {
	const lines = text.split(/\r?\n/);
	const chains: string[] = [];
	const residues = new Set<string>();
	let atoms = 0;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() !== "loop_" || !lines[i + 1]?.trim().startsWith("_atom_site.")) continue;
		const columns: string[] = [];
		let row = i + 1;
		while (row < lines.length && lines[row]!.trim().startsWith("_atom_site.")) {
			columns.push(lines[row]!.trim().slice("_atom_site.".length));
			row++;
		}
		const col = (...names: string[]): number => {
			for (const name of names) {
				const at = columns.indexOf(name);
				if (at >= 0) return at;
			}
			return -1;
		};
		const comp = col("label_comp_id", "auth_comp_id");
		const chainCol = col("auth_asym_id", "label_asym_id");
		const seq = col("auth_seq_id", "label_seq_id");
		const ins = col("pdbx_PDB_ins_code");
		const model = col("pdbx_PDB_model_num");
		let firstModel: string | undefined;
		for (; row < lines.length; row++) {
			const line = lines[row]!;
			const trimmed = line.trim();
			if (trimmed === "" ) continue;
			if (trimmed.startsWith("#") || trimmed === "loop_" || trimmed.startsWith("_") || trimmed.startsWith("data_")) break;
			const t = cifTokens(line);
			if (t.length < columns.length) continue;
			if (model >= 0) {
				firstModel ??= t[model];
				if (t[model] !== firstModel) break;
			}
			if (comp >= 0 && WATER.has(t[comp]!)) continue;
			const chain = chainCol >= 0 ? t[chainCol]! : "-";
			atoms++;
			if (!chains.includes(chain)) chains.push(chain);
			residues.add(`${chain}/${seq >= 0 ? t[seq] : ""}${ins >= 0 && t[ins] !== "?" && t[ins] !== "." ? t[ins] : ""}`);
		}
		break;
	}
	return { atoms, residues: residues.size, chains };
}

export function summarizeStructure(text: string, format: "pdb" | "cif"): StructureSummary {
	return format === "pdb" ? summarizePdb(text) : summarizeCif(text);
}
