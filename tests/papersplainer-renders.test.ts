/**
 * papersplainer render jobs: the Manim animation maker and the Molecular
 * Nodes structure render.
 *
 *   1. contracts (file names, failure shapes, steer text)
 *   2. the manim-maker loop with a fake model + fake renderer
 *   3. the molecule render's input rules and result shaping (fake Blender run)
 *   4. REAL renders, only when LH_MANIM_PYTHON / LH_MOLECULE_PYTHON point at
 *      interpreters with manim / molecularnodes installed (skipped otherwise)
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
import { moleculeInputProblem, renderMolecule } from "../src/agent/subagents/molecule-render.ts";
import { uvAssetName } from "../src/agent/subagents/render-env.ts";
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
		assert.equal(isRenderFileName("../secrets.png"), false);
		assert.equal(isRenderFileName("a/b.mp4"), false);
		assert.equal(isRenderFileName("clip.exe"), false);
		assert.equal(isRenderFileName(""), false);
	});

	it("an empty file is the failure shape for both kinds", () => {
		assert.equal(isSubagentFailure("manim", { title: "T", file: "", notes: "FAILED: x" }), true);
		assert.equal(isSubagentFailure("manim", { title: "T", file: "j.mp4" }), false);
		assert.equal(isSubagentFailure("molecule", { title: "T", file: "", source: "PDB 4HHB", notes: "FAILED: x" }), true);
		assert.equal(isSubagentFailure("molecule", { title: "T", file: "j.png", source: "PDB 4HHB" }), false);
	});

	it("steer text tells the guide what arrived, and that it has not seen a structure image", () => {
		const job = { id: "j1", toolCallId: "t1" };
		const ok = buildSubagentSteer({ ...job, kind: "manim" }, { title: "Matrix fill", file: "j1.mp4", notes: "Cells fill row by row." });
		assert.match(ok.content as string, /Matrix fill/);
		assert.match(ok.content as string, /Cells fill row by row/);
		const bad = buildSubagentSteer({ ...job, kind: "manim" }, { title: "Matrix fill", file: "", notes: "FAILED: no LaTeX" });
		assert.match(bad.content as string, /could not be rendered: FAILED: no LaTeX/);
		const mol = buildSubagentSteer({ ...job, kind: "molecule" }, { title: "Haemoglobin", file: "j1.png", source: "PDB 4HHB", notes: "4 chains" });
		assert.match(mol.content as string, /You have not seen the image yourself/);
	});

	it("names the uv download for each supported platform", () => {
		assert.equal(uvAssetName("win32", "x64"), "uv-x86_64-pc-windows-msvc.zip");
		assert.equal(uvAssetName("darwin", "arm64"), "uv-aarch64-apple-darwin.tar.gz");
		assert.equal(uvAssetName("linux", "x64"), "uv-x86_64-unknown-linux-gnu.tar.gz");
		assert.equal(uvAssetName("linux", "ia32"), null);
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

describe("molecule render", () => {
	it("requires exactly one valid source and known style/colour", () => {
		assert.equal(moleculeInputProblem({ pdbId: "4HHB" }), null);
		assert.equal(moleculeInputProblem({ path: "~/structures/model.cif", style: "surface", color: "plddt" }), null);
		assert.match(moleculeInputProblem({}) ?? "", /exactly one/);
		assert.match(moleculeInputProblem({ pdbId: "4HHB", path: "a.pdb" }) ?? "", /exactly one/);
		assert.match(moleculeInputProblem({ pdbId: "haemoglobin" }) ?? "", /not a PDB ID/);
		assert.match(moleculeInputProblem({ path: "notes.txt" }) ?? "", /structure file must be/);
		assert.match(moleculeInputProblem({ pdbId: "4HHB", style: "wireframe" }) ?? "", /style must be/);
	});

	it("shapes the result from the render summary", async () => {
		const out = path.join(tmp, "m", "job6.png");
		const result = await renderMolecule({ title: "Haemoglobin", pdbId: "4hhb", style: "surface" }, {
			outputPath: out,
			run: async (spec) => {
				assert.equal(spec.pdbId, "4HHB");
				assert.equal(spec.style, "surface");
				assert.equal(spec.color, "common");
				fs.writeFileSync(spec.out, png());
				return { atoms: 4779, residues: 574, chains: ["A", "B", "C", "D"] };
			},
		});
		assert.equal(result.file, "job6.png");
		assert.equal(result.source, "PDB 4HHB");
		assert.match(result.notes ?? "", /4779 atoms, 574 residues, 4 chains \(A, B, C, D\)/);
	});

	it("a failed render is the failure shape with the reason", async () => {
		const result = await renderMolecule({ title: "X", pdbId: "9ZZZ" }, {
			outputPath: path.join(tmp, "m", "job7.png"),
			run: async () => { throw new Error("HTTP 404 for 9ZZZ"); },
		});
		assert.equal(result.file, "");
		assert.equal(result.notes, "FAILED: HTTP 404 for 9ZZZ");
	});
});

describe("real renders (need LH_MANIM_PYTHON / LH_MOLECULE_PYTHON)", () => {
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

	it("Manim reports a Python error as a render error", { skip: !process.env.LH_MANIM_PYTHON }, async () => {
		const renderer = createManimRenderer();
		assert.equal(await renderer.prepare(() => {}), null);
		await assert.rejects(renderer.render(SCENE.replace("Square()", "Sqare()"), "preview"), /Sqare/);
		await renderer.dispose();
	});

	it("Molecular Nodes renders a local structure file", { skip: !process.env.LH_MOLECULE_PYTHON }, async () => {
		const out = path.join(tmp, "real", "helix.png");
		const result = await renderMolecule(
			{ title: "Test helix", file: path.resolve("tests/helpers/helix.pdb") },
			{ outputPath: out },
		);
		assert.equal(result.file, "helix.png", result.notes);
		assert.ok(fs.statSync(out).size > 10_000, "a real png was written");
		assert.match(result.notes ?? "", /120 atoms, 24 residues, 1 chain \(A\)/);
	});
});
