/**
 * papersplainer visuals: the Manim animation maker and the molecule
 * viewer tool.
 *
 *   1. contracts (file names, failure shapes, steer text)
 *   2. the manim-maker loop with a fake model + fake renderer
 *   3. the molecule tool: input rules, structure summaries, saved file,
 *      viewer style mapping
 *   4. REAL Manim renders, only when LH_MANIM_PYTHON points at an
 *      interpreter with manim installed (skipped otherwise)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createManimRenderer, runManimMaker, sceneProblem, type ManimRender, type ManimRenderer } from "../src/agent/subagents/manim-maker.ts";
import { createMoleculeTool, moleculeInputProblem } from "../src/agent/tools/molecule.ts";
import { safeFetchOverride } from "../src/agent/tools/safe-fetch.ts";
import { chatRendersDir, micromambaAssetName, needsCondaBase, runProcess, scrubbedEnv, trimEnv, uvAssetName } from "../src/agent/subagents/render-env.ts";
import { summarizeCif, summarizePdb } from "../src/core/structure-summary.ts";
import { moleculeViewSpec } from "../components/artifacts/molecule-style.ts";
import type { MoleculeDetails } from "../src/core/contracts.ts";
import { buildSubagentSteer, isRenderFileName, isSubagentFailure } from "../src/core/contracts.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papersplainer-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function scriptedModel(turns: Array<{ toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>; text?: string }>): PiEngine {
	const steps: FauxResponseStep[] = turns.map((step) =>
		step.toolCalls
			? fauxAssistantMessage(
					step.toolCalls.map((c) => fauxToolCall(c.toolName, c.input as ToolCall["arguments"], { id: c.toolCallId })),
					{ stopReason: "toolUse" },
				)
			: fauxAssistantMessage(step.text ?? ""),
	);
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function png(): Buffer {
	const canvas = createCanvas(64, 36);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#123";
	ctx.fillRect(0, 0, 64, 36);
	return canvas.toBuffer("image/png");
}

function fakeRenderer(opts: { failures?: number; unavailable?: string } = {}): ManimRenderer & { renders: Array<{ code: string; quality: string }> } {
	const video = path.join(tmp, "fake.mp4");
	fs.writeFileSync(video, "not really a video");
	let failures = opts.failures ?? 0;
	const api = {
		renders: [] as Array<{ code: string; quality: string }>,
		latex: false,
		async prepare() { return opts.unavailable ?? null; },
		async render(code: string, quality: "preview" | "final"): Promise<ManimRender> {
			api.renders.push({ code, quality });
			if (failures-- > 0) throw new Error("NameError: name 'Sqare' is not defined");
			return { video, durationSec: 12, frames: [{ png: png(), atSec: 1 }, { png: png(), atSec: 11 }] };
		},
		async dispose() {},
	};
	return api;
}

const SCENE = "from manim import *\n\nclass Explainer(Scene):\n    def construct(self):\n        self.play(Create(Square()))\n        self.wait(0.5)\n";

describe("papersplainer contracts", () => {
	it("accepts only plain render file names", () => {
		assert.equal(isRenderFileName("job_abc-1.mp4"), true);
		assert.equal(isRenderFileName("job_abc.png"), true);
		assert.equal(isRenderFileName("mol_call-1.cif"), true);
		assert.equal(isRenderFileName("mol_call-1.pdb"), true);
		assert.equal(isRenderFileName("../secrets.png"), false);
		assert.equal(isRenderFileName("a/b.mp4"), false);
		assert.equal(isRenderFileName("clip.exe"), false);
		assert.equal(isRenderFileName(""), false);
	});

	it("an empty file is the animation failure shape", () => {
		assert.equal(isSubagentFailure("manim", { title: "T", file: "", notes: "FAILED: x" }), true);
		assert.equal(isSubagentFailure("manim", { title: "T", file: "j.mp4" }), false);
	});

	it("steer text tells the guide what arrived", () => {
		const job = { id: "j1", toolCallId: "t1" };
		const ok = buildSubagentSteer({ ...job, kind: "manim" }, { title: "Matrix fill", file: "j1.mp4", notes: "Cells fill row by row." });
		assert.match(ok.content as string, /Matrix fill/);
		assert.match(ok.content as string, /Cells fill row by row/);
		const bad = buildSubagentSteer({ ...job, kind: "manim" }, { title: "Matrix fill", file: "", notes: "FAILED: no LaTeX" });
		assert.match(bad.content as string, /could not be rendered: FAILED: no LaTeX/);
	});

	it("names the uv download for each supported platform", () => {
		assert.equal(uvAssetName("win32", "x64"), "uv-x86_64-pc-windows-msvc.zip");
		assert.equal(uvAssetName("darwin", "arm64"), "uv-aarch64-apple-darwin.tar.gz");
		assert.equal(uvAssetName("linux", "x64"), "uv-x86_64-unknown-linux-gnu.tar.gz");
		assert.equal(uvAssetName("linux", "ia32"), null);
	});

	it("macOS gets its cairo binding prebuilt; Windows installs from wheels alone", () => {
		assert.equal(needsCondaBase("darwin"), true);
		assert.equal(needsCondaBase("win32"), process.env.LH_CONDA_BASE === "1");
		assert.equal(micromambaAssetName("darwin", "arm64"), "micromamba-osx-arm64");
		assert.equal(micromambaAssetName("darwin", "x64"), "micromamba-osx-64");
		assert.equal(micromambaAssetName("win32", "x64"), null);
	});
});

describe("manim maker (fake model + fake renderer)", () => {
	it("rejects a source without the Explainer scene or the manim import", () => {
		assert.equal(sceneProblem(SCENE), null);
		assert.match(sceneProblem("from manim import *\nclass Other(Scene):\n    pass") ?? "", /class Explainer/);
		assert.match(sceneProblem("class Explainer(Scene):\n    pass") ?? "", /import manim/);
	});

	it("write → render → look → finish renders the final clip and delivers it", async () => {
		const renderer = fakeRenderer();
		const out = path.join(tmp, "a", "job1.mp4");
		const result = await runManimMaker({ title: "Square", brief: "Draw a square." }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolCallId: "w1", toolName: "write_scene", input: { code: SCENE } }] },
				{ toolCalls: [{ toolCallId: "r1", toolName: "render_scene", input: {} }] },
				{ text: "A square is drawn, then held." },
			]),
			renderer,
			outputPath: out,
		});
		assert.equal(result.file, "job1.mp4");
		assert.equal(result.title, "Square");
		assert.equal(result.durationSec, 12);
		assert.equal(result.notes, "A square is drawn, then held.");
		assert.deepEqual(renderer.renders.map((r) => r.quality), ["preview", "final"]);
		assert.equal(fs.existsSync(out), true);
	});

	it("forces a look when the model finishes without rendering its final code", async () => {
		const renderer = fakeRenderer();
		const result = await runManimMaker({ title: "T", brief: "b" }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolCallId: "w1", toolName: "write_scene", input: { code: SCENE } }] },
				{ text: "Done without looking." },
				{ text: "Looked now; it is correct." },
			]),
			renderer,
			outputPath: path.join(tmp, "b", "job2.mp4"),
		});
		assert.equal(result.file, "job2.mp4");
		assert.equal(result.notes, "Looked now; it is correct.");
		assert.deepEqual(renderer.renders.map((r) => r.quality), ["preview", "final"]);
	});

	it("feeds a render error back and delivers the fixed scene", async () => {
		const renderer = fakeRenderer({ failures: 1 });
		const result = await runManimMaker({ title: "T", brief: "b" }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolCallId: "w1", toolName: "write_scene", input: { code: SCENE.replace("Square", "Sqare") } }] },
				{ toolCalls: [{ toolCallId: "r1", toolName: "render_scene", input: {} }] },
				{ toolCalls: [{ toolCallId: "e1", toolName: "edit_scene", input: { old_text: "Sqare", new_text: "Square" } }] },
				{ toolCalls: [{ toolCallId: "r2", toolName: "render_scene", input: {} }] },
				{ text: "Fixed." },
			]),
			renderer,
			outputPath: path.join(tmp, "c", "job3.mp4"),
		});
		assert.equal(result.file, "job3.mp4");
		assert.equal(renderer.renders.at(-1)?.code, SCENE);
	});

	it("fails honestly when the model never writes a scene", async () => {
		const result = await runManimMaker({ title: "T", brief: "b" }, {
			engine: scriptedModel([{ text: "I cannot animate this." }]),
			renderer: fakeRenderer(),
			outputPath: path.join(tmp, "d", "job4.mp4"),
		});
		assert.equal(result.file, "");
		assert.match(result.notes ?? "", /^FAILED: the maker never wrote a scene/);
	});

	it("fails honestly when the Manim environment is unavailable", async () => {
		const result = await runManimMaker({ title: "T", brief: "b" }, {
			engine: scriptedModel([{ text: "unreached" }]),
			renderer: fakeRenderer({ unavailable: "the Manim environment could not be set up: no network" }),
			outputPath: path.join(tmp, "e", "job5.mp4"),
		});
		assert.equal(result.file, "");
		assert.match(result.notes ?? "", /^FAILED: the Manim environment could not be set up/);
	});
});

const HELIX = fs.readFileSync(path.resolve("tests/helpers/helix.pdb"), "utf-8");
const TINY_CIF = `data_TEST
#
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.auth_seq_id
_atom_site.auth_asym_id
_atom_site.pdbx_PDB_model_num
ATOM   1 N N   MET A 1 1.0 2.0 3.0 1  A 1
ATOM   2 C CA  MET A 1 1.5 2.0 3.0 1  A 1
ATOM   3 N N   VAL A 2 2.0 2.0 3.0 2  A 1
ATOM   4 N N   LEU B 1 9.0 2.0 3.0 1  B 1
HETATM 5 O O   HOH C . 5.0 5.0 5.0 99 A 1
HETATM 6 C "C1'" HEM D . 4.0 4.0 4.0 142 A 1
ATOM   7 N N   MET A 1 1.1 2.0 3.0 1  A 2
#
`;

describe("molecule tool", () => {
	it("requires exactly one valid source", () => {
		assert.equal(moleculeInputProblem({ pdbId: "4HHB" }), null);
		assert.equal(moleculeInputProblem({ path: "~/structures/model.cif" }), null);
		assert.match(moleculeInputProblem({}) ?? "", /exactly one/);
		assert.match(moleculeInputProblem({ pdbId: "4HHB", path: "a.pdb" }) ?? "", /exactly one/);
		assert.match(moleculeInputProblem({ pdbId: "haemoglobin" }) ?? "", /not a PDB ID/);
		assert.match(moleculeInputProblem({ path: "notes.txt" }) ?? "", /structure file must be/);
	});

	it("summarizes a PDB file: atoms, residues, chains", () => {
		assert.deepEqual(summarizePdb(HELIX), { atoms: 120, residues: 24, chains: ["A"] });
	});

	it("summarizes an mmCIF file: first model only, water skipped, quoted values handled", () => {
		assert.deepEqual(summarizeCif(TINY_CIF), { atoms: 5, residues: 4, chains: ["A", "B"] });
		assert.deepEqual(summarizeCif("data_EMPTY\n#\n"), { atoms: 0, residues: 0, chains: [] });
	});

	it("saves a local structure with the session and records how to draw it", async () => {
		const chatId = `chat_test_mol_${Date.now().toString(36)}`;
		after(() => fs.rmSync(chatRendersDir(chatId), { recursive: true, force: true }));
		const tool = createMoleculeTool({ chatId });
		const result = await tool.execute("call/weird id:1", { title: "Test helix", path: path.resolve("tests/helpers/helix.pdb"), style: "sticks", color: "spectrum" });
		const details = result.details as MoleculeDetails;
		assert.equal(details.file, "mol_callweirdid1.pdb");
		assert.equal(isRenderFileName(details.file), true);
		assert.equal(details.format, "pdb");
		assert.equal(details.style, "sticks");
		assert.equal(details.color, "spectrum");
		assert.equal(details.atoms, 120);
		assert.deepEqual(details.chains, ["A"]);
		assert.equal(fs.readFileSync(path.join(chatRendersDir(chatId), details.file), "utf-8"), HELIX);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /120 atoms, 24 residues, 1 chain \(A\)/);
		assert.match(text, /You have not seen it yourself/);
	});

	it("downloads a PDB entry as mmCIF and defaults to cartoon by chain", async () => {
		const chatId = `chat_test_mol2_${Date.now().toString(36)}`;
		after(() => fs.rmSync(chatRendersDir(chatId), { recursive: true, force: true }));
		const requested: string[] = [];
		safeFetchOverride.current = async (url) => { requested.push(url); return new Response(TINY_CIF, { status: 200 }); };
		try {
			const result = await createMoleculeTool({ chatId }).execute("call-2", { title: "Tiny", pdbId: "4hhb" });
			const details = result.details as MoleculeDetails;
			assert.deepEqual(requested, ["https://files.rcsb.org/download/4HHB.cif"]);
			assert.equal(details.source, "PDB 4HHB");
			assert.equal(details.format, "cif");
			assert.equal(details.style, "cartoon");
			assert.equal(details.color, "chain");
			assert.deepEqual(details.chains, ["A", "B"]);
		} finally {
			safeFetchOverride.current = undefined;
		}
	});

	it("an unknown PDB ID or a non-structure file fails the call with a reason", async () => {
		const tool = createMoleculeTool({ chatId: "chat_test_mol3" });
		safeFetchOverride.current = async () => new Response("not found", { status: 404 });
		try {
			await assert.rejects(tool.execute("c1", { title: "X", pdbId: "9ZZZ" }), /PDB has no entry 9ZZZ/);
		} finally {
			safeFetchOverride.current = undefined;
		}
		const notStructure = path.join(tmp, "empty.pdb");
		fs.writeFileSync(notStructure, "REMARK nothing here\n");
		await assert.rejects(tool.execute("c2", { title: "X", path: notStructure }), /no atoms found/);
		await assert.rejects(tool.execute("c3", { title: "X" }), /exactly one/);
	});

	it("maps style and colour choices onto viewer styles", () => {
		assert.deepEqual(moleculeViewSpec("cartoon", "chain"), { atomStyle: { cartoon: { colorscheme: "chain" } } });
		assert.deepEqual(moleculeViewSpec("cartoon", "spectrum"), { atomStyle: { cartoon: { color: "spectrum" } } });
		assert.deepEqual(moleculeViewSpec("sticks", "spectrum", { min: 5, max: 90 }), {
			atomStyle: { stick: { colorscheme: { prop: "resi", gradient: "sinebow", min: 5, max: 90 }, radius: 0.2 } },
		});
		assert.deepEqual(moleculeViewSpec("spheres", "plddt").atomStyle.sphere, { colorscheme: { prop: "b", gradient: "roygb", min: 50, max: 90 } });
		const surface = moleculeViewSpec("surface", "element");
		assert.deepEqual(surface.surface, { colorscheme: "default", opacity: 0.85 });
		assert.ok(surface.atomStyle.cartoon, "a faint cartoon sits under the surface");
		assert.deepEqual(Object.keys(moleculeViewSpec("ball_and_stick", "secondary_structure").atomStyle).sort(), ["sphere", "stick"]);
	});
});

describe("render environment", () => {
	it("trimming removes test suites and OpenGL-only packages, and nothing else", async () => {
		const env = path.join(tmp, "env");
		const site = path.join(env, "lib", "python3.11", "site-packages");
		for (const dir of ["scipy/linalg/tests", "numpy/core", "pyglm", "manim/mobject", "networkx/tests"]) fs.mkdirSync(path.join(site, dir), { recursive: true });
		fs.writeFileSync(path.join(site, "numpy/core/keep.py"), "x = 1\n");
		await trimEnv(env);
		assert.equal(fs.existsSync(path.join(site, "scipy/linalg/tests")), false);
		assert.equal(fs.existsSync(path.join(site, "networkx/tests")), false);
		assert.equal(fs.existsSync(path.join(site, "pyglm")), false);
		assert.equal(fs.existsSync(path.join(site, "scipy/linalg")), true);
		assert.equal(fs.existsSync(path.join(site, "manim/mobject")), true);
		assert.equal(fs.existsSync(path.join(site, "numpy/core/keep.py")), true);
	});
});

describe("real renders (need LH_MANIM_PYTHON)", () => {
	it("Manim renders a scripted scene end to end", { skip: !process.env.LH_MANIM_PYTHON }, async () => {
		const out = path.join(tmp, "real", "clip.mp4");
		const result = await runManimMaker({ title: "Square", brief: "Draw a square." }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolCallId: "w1", toolName: "write_scene", input: { code: SCENE } }] },
				{ toolCalls: [{ toolCallId: "r1", toolName: "render_scene", input: {} }] },
				{ text: "A square is drawn." },
			]),
			renderer: createManimRenderer(),
			outputPath: out,
		});
		assert.equal(result.file, "clip.mp4", result.notes);
		assert.ok(fs.statSync(out).size > 1000, "a real mp4 was written");
		assert.ok((result.durationSec ?? 0) > 1);
	});

	it("a scene that reaches for files, processes or internals is rejected before it runs", { skip: !process.env.LH_MANIM_PYTHON }, async () => {
		const renderer = createManimRenderer();
		assert.equal(await renderer.prepare(() => {}), null);
		const marker = path.join(tmp, "must-not-exist.txt");
		const hostile = [
			"from manim import *",
			"import os",
			"class Explainer(Scene):",
			"    def construct(self):",
			`        open(${JSON.stringify(marker)}, "w").write("ran")`,
			"        getattr(os, 'system')('echo hi')",
			"        self.wait(0.1)",
		].join("\n");
		await assert.rejects(renderer.render(hostile, "preview"), (err: Error) => {
			assert.match(err.message, /^NOT ALLOWED, the scene was not run/);
			assert.match(err.message, /line 2: import of 'os' is not allowed/);
			assert.match(err.message, /line 5: open\(\) may only read example data files under data\//);
			assert.match(err.message, /line 6: 'getattr' is not allowed/);
			return true;
		});
		assert.equal(fs.existsSync(marker), false, "the scene never executed");
		await renderer.dispose();
	});

	it("a model-written script inherits no secrets from the app's environment", { skip: !process.env.LH_MANIM_PYTHON }, async () => {
		const secret = "sk-test-secret-value-123";
		process.env.PAPERSPLAINER_TEST_API_KEY = secret;
		try {
			const probe = "import os; print(os.environ.get('PAPERSPLAINER_TEST_API_KEY'), 'PATH' in os.environ)";
			const open = await runProcess(process.env.LH_MANIM_PYTHON!, ["-c", probe]);
			assert.equal(open.stdout.trim(), `${secret} True`, "without scrubbing the child sees the variable");
			const scrubbed = await runProcess(process.env.LH_MANIM_PYTHON!, ["-c", probe], { scrubEnv: true });
			assert.equal(scrubbed.stdout.trim(), "None True", "with scrubbing it does not, and PATH survives");
		} finally {
			delete process.env.PAPERSPLAINER_TEST_API_KEY;
		}
		assert.deepEqual(
			Object.keys(scrubbedEnv({ PATH: "/bin", Path: "C:\\x", OPENROUTER_API_KEY: secret, GITHUB_TOKEN: "t", LH_DATA_DIR: "/d", TEXMFHOME: "/t", HOME: "/h" })).sort(),
			["HOME", "PATH", "Path", "TEXMFHOME"],
		);
	});

	it("Manim reports a Python error as a render error", { skip: !process.env.LH_MANIM_PYTHON }, async () => {
		const renderer = createManimRenderer();
		assert.equal(await renderer.prepare(() => {}), null);
		await assert.rejects(renderer.render(SCENE.replace("Square()", "Sqare()"), "preview"), /Sqare/);
		await renderer.dispose();
	});
});
