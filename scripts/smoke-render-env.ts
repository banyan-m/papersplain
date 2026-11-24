/**
 * papersplainer: end-to-end check of the first-launch setup on a real
 * machine. Run with LH_DATA_DIR pointing at an empty folder:
 *
 *   LH_DATA_DIR=/tmp/pp-smoke npx tsx scripts/smoke-render-env.ts
 *
 * It installs the Manim environment from scratch exactly as the app does,
 * renders a small animation with it, and makes a toy dataset through the
 * Python sandbox. Exits non-zero on the first failure.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../config.ts";
import { createManimRenderer } from "../src/agent/subagents/manim-maker.ts";
import { ensureRenderEnv, renderEnvStatus } from "../src/agent/subagents/render-env.ts";
import { createToyDataRunner } from "../src/agent/subagents/toy-data-maker.ts";

const SCENE = [
	"from manim import *",
	"class Explainer(Scene):",
	"    def construct(self):",
	"        title = Text('papersplainer', font_size=40).to_edge(UP)",
	"        grid = VGroup(*[Square(0.7) for _ in range(9)]).arrange_in_grid(3, 3, buff=0)",
	"        self.play(Write(title))",
	"        self.play(Create(grid))",
	"        self.play(grid[4].animate.set_fill(YELLOW, 0.8))",
	"        self.wait(0.3)",
].join("\n");

const GENERATOR = [
	"from papertoy import sam_to_bam, write_h5",
	"open('toy_reference.fa', 'w').write('>toy_chr1\\n' + 'ACGT' * 15 + '\\n')",
	"open('toy_reads.fastq', 'w').write('@read_1\\nACGTACGTACGT\\n+\\nIIIIIIIIIIII\\n')",
	"open('toy.sam', 'w').write('@SQ\\tSN:toy_chr1\\tLN:60\\nread_1\\t0\\ttoy_chr1\\t1\\t60\\t12M\\t*\\t0\\t0\\tACGTACGTACGT\\tIIIIIIIIIIII\\n')",
	"sam_to_bam('toy.sam', 'toy.bam')",
	"write_h5('toy_cells.h5ad', {'X': {'data': [[1, 0], [0, 2]], 'dtype': 'float32'}, 'obs/_index': {'data': ['cell_1', 'cell_2'], 'dtype': 'str'}, 'var/_index': {'data': ['gene_1', 'gene_2'], 'dtype': 'str'}})",
].join("\n");

function folderMegabytes(dir: string): number {
	let bytes = 0;
	if (!fs.existsSync(dir)) return 0; // an interpreter supplied through LH_MANIM_PYTHON
	const walk = (d: string) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) walk(full);
			else bytes += fs.statSync(full).size;
		}
	};
	walk(dir);
	return Math.round(bytes / 1024 / 1024);
}

async function main(): Promise<void> {
	if (!process.env.LH_DATA_DIR) throw new Error("set LH_DATA_DIR to an empty folder");
	console.log(`platform ${process.platform}/${process.arch}, data ${PATHS.data}`);

	let started = Date.now();
	const python = await ensureRenderEnv("manim", (line) => console.log(`  setup: ${line}`));
	console.log(`environment ready in ${Math.round((Date.now() - started) / 1000)} s: ${python}`);
	console.log(`environment size: ${folderMegabytes(PATHS.renderEnv)} MB; status ${JSON.stringify(renderEnvStatus())}`);

	started = Date.now();
	const renderer = createManimRenderer();
	const unavailable = await renderer.prepare((line) => console.log(`  render: ${line}`));
	if (unavailable) throw new Error(unavailable);
	try {
		const preview = await renderer.render(SCENE, "preview");
		if (preview.frames.length === 0 || preview.durationSec <= 0) throw new Error("the preview render produced no frames");
		const final = await renderer.render(SCENE, "final");
		console.log(`animation rendered: ${final.durationSec.toFixed(1)} s clip, ${fs.statSync(final.video).size} bytes, in ${Math.round((Date.now() - started) / 1000)} s`);
		let refused = false;
		try {
			await renderer.render("from manim import *\nimport os\nclass Explainer(Scene):\n    def construct(self):\n        os.getcwd()\n", "preview");
		} catch (err) {
			refused = /NOT ALLOWED/.test(String(err));
		}
		if (!refused) throw new Error("the scene check did not refuse a scene that imports os");
		console.log("scene check refuses a disallowed scene");
	} finally {
		await renderer.dispose();
	}

	started = Date.now();
	const runner = createToyDataRunner();
	const cannot = await runner.prepare((line) => console.log(`  toy data: ${line}`));
	if (cannot) throw new Error(cannot);
	try {
		const run = await runner.run(GENERATOR);
		const summary = run.files.map((f) => `${f.name}[${f.format}${f.checked ? "" : " UNCHECKED"}${f.problems.length ? ` PROBLEMS ${f.problems.join("; ")}` : ""}]`).join(" ");
		console.log(`toy data in ${Math.round((Date.now() - started) / 1000)} s: ${summary}`);
		const names = run.files.map((f) => f.name).sort().join(",");
		if (names !== "toy.bam,toy.sam,toy_cells.h5ad,toy_reads.fastq,toy_reference.fa") throw new Error(`unexpected files: ${names}`);
		if (run.files.some((f) => !f.checked || f.problems.length > 0)) throw new Error("a toy file failed its check");
	} finally {
		await runner.dispose();
	}
	console.log("SMOKE OK");
}

main().then(() => process.exit(0), (err) => {
	console.error("SMOKE FAILED:", err instanceof Error ? err.stack ?? err.message : err);
	process.exit(1);
});
