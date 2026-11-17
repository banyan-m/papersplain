/**
 * papersplainer: the per-paper cache.
 *
 *   1. pure helpers (figure captions, file names, the makers' data context)
 *   2. figure pages extracted from a real PDF, and the paper_figure tool
 *   3. the toy-data maker loop with a fake model + fake runner
 *   4. REAL runs (need LH_MANIM_PYTHON: an interpreter with numpy + h5py):
 *      the format checker, the BAM writer, a scripted generator end to end,
 *      the runner's job, reuse by a second session, and a Manim scene
 *      reading the data
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { PATHS } from "../config.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { createPaperFigureTool } from "../src/agent/tools/paper-figure.ts";
import { chatCacheKey, chatPaperKey, chatToyData, ensurePaperFigures, forgetChatPaper, paperCacheDir, paperKeyForFile, readManifest, setChatPaper, toyDir } from "../src/agent/subagents/paper-cache-store.ts";
import { createJobRunner, demoModelOverride, pdfModelOverride, visualModelOverride } from "../src/agent/subagents/runner.ts";
import { chatRendersDir } from "../src/agent/subagents/render-env.ts";
import { createToyDataRunner, runProblems, runReport, runToyDataMaker, type CheckedFile, type ToyDataRunner } from "../src/agent/subagents/toy-data-maker.ts";
import { buildSubagentSteer, isSubagentFailure, type ManimResult, type ShowImageDetails, type SteerMessage, type ToyDataResult } from "../src/core/contracts.ts";
import { findFigureCaptions, isCacheFileName, isPaperKey, toyDataContext } from "../src/core/paper-cache.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { GET as getPaperData } from "../app/api/chats/[id]/paper-data/[file]/route.ts";

const PYTHON = process.env.LH_MANIM_PYTHON;
const PDF = path.resolve("tests/helpers/toy-paper.pdf");
const TOY_DATA_DIR = path.resolve("src/agent/subagents/toy-data");
const JOBS_DIR = path.join(PATHS.data, "jobs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papersplainer-cache-"));
const createdChats: string[] = [];
const createdJobs: string[] = [];
const createdKeys: string[] = [];
after(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	for (const id of createdChats) {
		fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
		fs.rmSync(chatRendersDir(id), { recursive: true, force: true });
		forgetChatPaper(id);
	}
	for (const id of createdJobs) fs.rmSync(path.join(JOBS_DIR, `${id}.json`), { force: true });
	for (const key of createdKeys) fs.rmSync(paperCacheDir(key), { recursive: true, force: true });
});

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

function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 50);
		};
		tick();
	});
}

const file = (name: string, over: Partial<CheckedFile> = {}): CheckedFile => ({
	name, format: "fastq", bytes: 40, checked: true, summary: "2 reads", preview: "@r1\nACGT\n+\nIIII", problems: [], ...over,
});

describe("paper cache helpers", () => {
	it("finds captions at line starts, skips in-text references and supplementary figures", () => {
		const captions = findFigureCaptions([
			{ page: 1, text: "As shown in Figure 2, accuracy rises.\nFigure 1 and Figure 2 together show it.\n\nFigure 1: Overview of the\npipeline in three steps.\n\nNext paragraph." },
			{ page: 3, text: "**Fig. 2.** Accuracy by read length.\nFigure S1: Extra.\nFigure 1: A later repeat of the label." },
			{ page: 4, text: "FIGURE 3 | Runtime on four genomes" },
		]);
		assert.deepEqual(captions, [
			{ number: 1, page: 1, caption: "Overview of the pipeline in three steps." },
			{ number: 2, page: 3, caption: "Accuracy by read length." },
			{ number: 3, page: 4, caption: "Runtime on four genomes" },
		]);
		assert.deepEqual(findFigureCaptions([{ page: 1, text: "No figures here." }]), []);
	});

	it("accepts only plain cache file names and well-formed keys", () => {
		for (const good of ["reads.fastq", "aln.bam", "cells.h5ad", "counts_matrix.tsv.gz", "signal_fast5_layout.txt"]) assert.equal(isCacheFileName(good), true, good);
		for (const bad of ["../x", "a/b.txt", ".hidden", "", "a..b", "name with space.txt", "x".repeat(120)]) assert.equal(isCacheFileName(bad), false, bad);
		assert.equal(isPaperKey("b7284a570cfb45c3"), true);
		assert.equal(isPaperKey("chat-chat_abc_123"), true);
		assert.equal(isPaperKey("../../etc"), false);
		assert.equal(isPaperKey("B7284A570CFB45C3"), false);
	});

	it("hands makers each file's name, format and opening lines, within a budget", () => {
		assert.equal(toyDataContext(undefined), "");
		const context = toyDataContext({ title: "T", createdAt: "", files: [file("reads.fastq"), file("big.tsv", { format: "tsv", summary: "9 rows", preview: "x".repeat(9000) })] }, "Read them from data/<name>.");
		assert.match(context, /not the study's real data/);
		assert.match(context, /### reads\.fastq \(fastq; 2 reads\)\n@r1\nACGT/);
		assert.match(context, /### big\.tsv/);
		assert.ok(context.length < 7000, "the long preview is cut to the budget");
		assert.match(context, /Read them from data\/<name>\.$/);
	});

	it("the dataset steer carries the files' opening lines to the guide", () => {
		const result: ToyDataResult = { title: "Toy reads", files: [file("reads.fastq")], notes: "reads.fastq: the sequencer output." };
		assert.equal(isSubagentFailure("dataset", result), false);
		assert.equal(isSubagentFailure("dataset", { title: "T", files: [], notes: "FAILED: x" }), true);
		const steer = buildSubagentSteer({ id: "j1", kind: "dataset", toolCallId: "t1" }, result).content as string;
		assert.match(steer, /### reads\.fastq/);
		assert.match(steer, /never the study's real data/);
		const reused = buildSubagentSteer({ id: "j1", kind: "dataset", toolCallId: "t1" }, { ...result, reused: true }).content as string;
		assert.match(reused, /already in this paper's cache from an earlier session/);
	});
});

describe("the paper's figures", () => {
	it("renders the page carrying each numbered figure, once per paper, and paper_figure shows it", async () => {
		const key = await paperKeyForFile(PDF);
		createdKeys.push(key);
		fs.rmSync(paperCacheDir(key), { recursive: true, force: true });
		const figures = await ensurePaperFigures(PDF, key);
		assert.deepEqual(figures.map((f) => [f.number, f.page, f.file]), [[1, 1, "figure-1.png"], [2, 2, "figure-2.png"]]);
		assert.match(figures[0]!.caption, /^Overview of the pipeline/);
		assert.equal(readManifest(key)?.figures?.length, 2);
		const stamp = fs.statSync(path.join(paperCacheDir(key), "figures", "figure-1.png")).mtimeMs;
		await ensurePaperFigures(PDF, key);
		assert.equal(fs.statSync(path.join(paperCacheDir(key), "figures", "figure-1.png")).mtimeMs, stamp, "a second call reuses the cache");

		const chat = chatStore.createChat("Test: paper figure", "paper");
		createdChats.push(chat.id);
		const tool = createPaperFigureTool({ chatId: chat.id, chatStore });
		await assert.rejects(tool.execute("c0", { figure: 1 }), /no paper has been read in this session yet/);
		setChatPaper(chat.id, key);
		const shown = await tool.execute("c1", { figure: 2 });
		const details = shown.details as ShowImageDetails;
		assert.match(details.caption ?? "", /^Figure 2 \(page 2\): Accuracy as a function of read length/);
		assert.ok(details.width > 500 && details.height > 500, "a full page render");
		assert.ok(chatStore.getChat(chat.id)?.imageSnapshots?.[details.snapshotId], "the page image is saved with the session");
		await assert.rejects(tool.execute("c2", { figure: 7 }), /there is no Figure 7; this paper's figures are: 1, 2/);
	});
});

describe("toy-data maker (fake model + fake runner)", () => {
	function fakeRunner(runs: CheckedFile[][], opts: { error?: string } = {}): ToyDataRunner & { codes: string[] } {
		const dir = fs.mkdtempSync(path.join(tmp, "fake-"));
		let n = 0;
		const api = {
			codes: [] as string[],
			async prepare() { return null; },
			async run(code: string) {
				api.codes.push(code);
				if (opts.error && n === 0) { n++; throw new Error(opts.error); }
				const files = runs[Math.min(n++, runs.length - 1)]!;
				for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.preview);
				return { dir, files };
			},
			async dispose() {},
		};
		return api;
	}

	it("reports whole-run problems: nothing written, bad names, oversized files", () => {
		assert.deepEqual(runProblems([]), ["the script wrote no files into the working directory"]);
		assert.match(runProblems([file("sub dir.txt")])[0]!, /plain file names/);
		assert.match(runProblems([file("big.fastq", { bytes: 600 * 1024 })])[0]!, /keep each file under 512 KB/);
		assert.equal(runReport([file("a.fastq")]).clean, true);
		const report = runReport([file("a.fastq", { checked: false, problems: ["line 2: sequence (6) and quality (3) lengths differ"] })]);
		assert.equal(report.clean, false);
		assert.match(report.text, /PROBLEM: line 2: sequence \(6\) and quality \(3\) lengths differ/);
	});

	it("write → run (problems) → fix → run (clean) → finish delivers the checked files", async () => {
		const runner = fakeRunner([
			[file("reads.fastq", { checked: false, problems: ["line 2: lengths differ"] })],
			[file("reads.fastq"), file("ref.fa", { format: "fasta", summary: "1 sequence", preview: ">toy_chr1\nACGT" })],
		]);
		const out = path.join(tmp, "out1");
		const result = await runToyDataMaker({ title: "Toy reads", brief: "FASTQ reads and a FASTA reference." }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolCallId: "w1", toolName: "write_script", input: { code: "v1" } }] },
				{ toolCalls: [{ toolCallId: "r1", toolName: "run_script", input: {} }] },
				{ toolCalls: [{ toolCallId: "e1", toolName: "edit_script", input: { old_text: "v1", new_text: "v2" } }] },
				{ toolCalls: [{ toolCallId: "r2", toolName: "run_script", input: {} }] },
				{ text: "reads.fastq: sequencer output. ref.fa: the reference they align to." },
			]),
			runner,
			outputDir: out,
		});
		assert.deepEqual(result.files.map((f) => f.name), ["reads.fastq", "ref.fa"]);
		assert.equal("problems" in result.files[0]!, false, "parse problems are not part of the delivered record");
		assert.equal(result.notes, "reads.fastq: sequencer output. ref.fa: the reference they align to.");
		assert.deepEqual(runner.codes, ["v1", "v2"]);
		assert.deepEqual(fs.readdirSync(out).sort(), ["reads.fastq", "ref.fa"]);
	});

	it("never delivers a script that has not had a clean run", async () => {
		const runner = fakeRunner([[file("reads.fastq")]]);
		const result = await runToyDataMaker({ title: "T", brief: "b" }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolCallId: "w1", toolName: "write_script", input: { code: "v1" } }] },
				{ text: "Done, trust me." },
				{ text: "reads.fastq: the reads." },
			]),
			runner,
			outputDir: path.join(tmp, "out2"),
		});
		assert.deepEqual(runner.codes, ["v1"], "the gate ran the unrun script itself");
		assert.equal(result.files.length, 1);
		assert.equal(result.notes, "reads.fastq: the reads.");
	});

	it("a script error is fed back; unfixed problems end in an honest failure", async () => {
		const runner = fakeRunner([[file("x.vcf", { checked: false, problems: ["no #CHROM header line"] })]], { error: "NameError: name 'opne' is not defined" });
		const result = await runToyDataMaker({ title: "T", brief: "b" }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolCallId: "w1", toolName: "write_script", input: { code: "v1" } }] },
				{ toolCalls: [{ toolCallId: "r1", toolName: "run_script", input: {} }] },
				{ toolCalls: [{ toolCallId: "r2", toolName: "run_script", input: {} }] },
				{ text: "Good enough." },
				{ text: "Still good enough." },
			]),
			runner,
			outputDir: path.join(tmp, "out3"),
			maxIterations: 5,
		});
		assert.equal(result.files.length, 0);
		assert.match(result.notes ?? "", /^FAILED: iteration limit \(5\) reached without a dataset that passed its checks/);
		assert.equal(fs.existsSync(path.join(tmp, "out3")), false, "nothing is written to the cache on failure");
	});

	it("fails honestly when the model never writes a script", async () => {
		const result = await runToyDataMaker({ title: "T", brief: "b" }, {
			engine: scriptedModel([{ text: "This paper has no data files." }]),
			runner: fakeRunner([[]]),
			outputDir: path.join(tmp, "out4"),
		});
		assert.match(result.notes ?? "", /^FAILED: the maker never wrote a script/);
	});
});

const GENERATOR = `
import random
import numpy as np
import h5py
from papertoy import sam_to_bam

random.seed(7)
ref = "".join(random.choice("ACGT") for _ in range(60))
with open("toy_reference.fa", "w") as f:
    f.write(">toy_chr1 illustrative reference\\n" + ref + "\\n")

reads = [(f"read_{i+1}", start, ref[start:start + 12]) for i, start in enumerate([0, 9, 21, 33, 44])]
with open("toy_reads.fastq", "w") as f:
    for name, _, seq in reads:
        f.write(f"@{name}\\n{seq}\\n+\\n{'I' * len(seq)}\\n")

with open("toy_alignments.sam", "w") as f:
    f.write("@HD\\tVN:1.6\\tSO:coordinate\\n@SQ\\tSN:toy_chr1\\tLN:60\\n")
    for name, start, seq in reads:
        f.write(f"{name}\\t0\\ttoy_chr1\\t{start + 1}\\t60\\t12M\\t*\\t0\\t0\\t{seq}\\t{'I' * 12}\\tNM:i:0\\n")
sam_to_bam("toy_alignments.sam", "toy_alignments.bam")

alt = "A" if ref[24] != "A" else "C"
with open("toy_variants.vcf", "w") as f:
    f.write("##fileformat=VCFv4.2\\n##contig=<ID=toy_chr1,length=60>\\n")
    f.write("#CHROM\\tPOS\\tID\\tREF\\tALT\\tQUAL\\tFILTER\\tINFO\\tFORMAT\\tsample_A\\n")
    f.write(f"toy_chr1\\t25\\t.\\t{ref[24]}\\t{alt}\\t50\\tPASS\\tDP=5\\tGT\\t0/1\\n")

with h5py.File("toy_cells.h5ad", "w") as f:
    f.create_dataset("X", data=np.random.default_rng(7).poisson(2, size=(4, 3)).astype("float32"))
    f.create_group("obs").create_dataset("_index", data=np.array([b"cell_1", b"cell_2", b"cell_3", b"cell_4"]))
    f.create_group("var").create_dataset("_index", data=np.array([b"gene_1", b"gene_2", b"gene_3"]))
`;

describe("real runs (need LH_MANIM_PYTHON)", () => {
	const check = (dir: string) => {
		const run = spawnSync(PYTHON!, [path.join(TOY_DATA_DIR, "checkdata.py"), dir], { encoding: "utf8", env: { ...process.env, PYTHONPATH: TOY_DATA_DIR } });
		assert.equal(run.status, 0, run.stderr);
		const line = run.stdout.split("\n").find((l) => l.startsWith("PAPERSPLAINER_CHECK "))!;
		return (JSON.parse(line.slice("PAPERSPLAINER_CHECK ".length)) as { files: CheckedFile[] }).files;
	};

	it("the checker accepts well-formed files and names what is wrong with broken ones", { skip: !PYTHON }, () => {
		const dir = fs.mkdtempSync(path.join(tmp, "check-"));
		const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
		write("ok.fa", ">toy_chr1\nACGTACGT\n");
		write("ok.fastq", "@r1\nACGT\n+\nIIII\n");
		write("ok.vcf", "##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\ntoy_chr1\t5\t.\tA\tG\t50\tPASS\tDP=3\n");
		write("ok.bed", "toy_chr1\t10\t20\tpeak_1\t100\t+\n");
		write("ok.gtf", 'toy_chr1\ttoy\texon\t1\t10\t.\t+\t.\tgene_id "gene_1"; transcript_id "tx_1";\n');
		write("ok.sam", "@SQ\tSN:toy_chr1\tLN:60\nr1\t0\ttoy_chr1\t1\t60\t4M\t*\t0\t0\tACGT\tIIII\n");
		write("ok.tsv", "gene\tsample_A\tsample_B\ngene_1\t5\t0\n");
		write("bad.fastq", "@r1\nACGTAC\n+\nIII\n");
		write("bad.vcf", "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\ntoy_chr1\tfive\t.\tA\tG\t50\tPASS\tDP=3\n");
		write("bad.sam", "@SQ\tSN:toy_chr1\tLN:60\nr1\t0\ttoy_chr9\t1\t60\t9M\t*\t0\t0\tACGT\tIIII\n");
		write("bad.csv", "gene,a,b\ngene_1,5\n");
		write("layout.xyz", "a stand-in\n");
		const files = Object.fromEntries(check(dir).map((f) => [f.name, f]));
		for (const name of ["ok.fa", "ok.fastq", "ok.vcf", "ok.bed", "ok.gtf", "ok.sam", "ok.tsv"]) assert.deepEqual([files[name]!.checked, files[name]!.problems], [true, []], name);
		assert.equal(files["ok.vcf"]!.summary, "1 variant, 0 samples");
		assert.match(files["bad.fastq"]!.problems[0]!, /sequence \(6\) and quality \(3\) lengths differ/);
		assert.match(files["bad.vcf"]!.problems.join(" | "), /first line must be ##fileformat.*POS is not an integer/);
		assert.match(files["bad.sam"]!.problems.join(" | "), /RNAME 'toy_chr9' has no @SQ header line.*CIGAR covers 9 query bases, SEQ has 4/);
		assert.match(files["bad.csv"]!.problems[0]!, /row 2 has 2 columns, the first row has 3/);
		assert.deepEqual([files["layout.xyz"]!.format, files["layout.xyz"]!.checked, files["layout.xyz"]!.problems], ["unchecked", false, []]);
	});

	it("a scripted generator runs for real: FASTA, FASTQ, SAM, BAM, VCF and an .h5ad are written, parsed back, and delivered", { skip: !PYTHON }, async () => {
		const out = path.join(tmp, "real-out");
		const result = await runToyDataMaker({ title: "Toy alignment data", brief: "Reads, reference, alignments, variants, cells." }, {
			engine: scriptedModel([
				{ toolCalls: [{ toolCallId: "w1", toolName: "write_script", input: { code: GENERATOR } }] },
				{ toolCalls: [{ toolCallId: "r1", toolName: "run_script", input: {} }] },
				{ text: "Six files that tell one alignment story." },
			]),
			runner: createToyDataRunner(),
			outputDir: out,
		});
		assert.deepEqual(result.files.map((f) => [f.name, f.format, f.checked]), [
			["toy_alignments.bam", "bam", true],
			["toy_alignments.sam", "sam", true],
			["toy_cells.h5ad", "h5ad", true],
			["toy_reads.fastq", "fastq", true],
			["toy_reference.fa", "fasta", true],
			["toy_variants.vcf", "vcf", true],
		], result.notes);
		const byName = Object.fromEntries(result.files.map((f) => [f.name, f]));
		assert.equal(byName["toy_alignments.bam"]!.summary, "5 alignments, 1 reference");
		assert.match(byName["toy_alignments.bam"]!.preview, /read_1\t0\ttoy_chr1\t1\t60\t12M/);
		assert.match(byName["toy_cells.h5ad"]!.preview, /X\s+dataset \(4, 3\) float32/);
		assert.deepEqual(fs.readdirSync(out).sort(), Object.keys(byName).sort());
		assert.equal(fs.readFileSync(path.join(out, "toy_alignments.bam")).subarray(0, 2).toString("hex"), "1f8b", "a real BGZF file");
		assert.ok(!fs.readdirSync(out).some((f) => f.endsWith(".py") || f === "__pycache__"), "helpers never ship as data");
	});

	it("a Python error in the generator comes back as the traceback", { skip: !PYTHON }, async () => {
		const runner = createToyDataRunner();
		assert.equal(await runner.prepare(() => {}), null);
		await assert.rejects(runner.run("opne('x.txt', 'w')"), /NameError: name 'opne' is not defined/);
		await runner.dispose();
	});

	it("the job stores the dataset with the paper; a second session on the same paper reuses it without a model; Manim reads it", { skip: !PYTHON }, async () => {
		const key = await paperKeyForFile(PDF);
		createdKeys.push(key);
		fs.rmSync(toyDir(key), { recursive: true, force: true });
		const steers: SteerMessage[] = [];
		const runner = createJobRunner({ chatStore, jobStore, deliver: async (steer) => { steers.push(steer); } });

		// Session 1 reads the paper (which links it to the paper's cache), then makes the dataset.
		const first = chatStore.createChat("Test: cache session 1", "paper");
		createdChats.push(first.id);
		const pdfJob = jobStore.createJob({ kind: "pdf", chatId: first.id, toolCallId: "call-pdf", input: { path: PDF, question: "Map the paper." } });
		createdJobs.push(pdfJob.id);
		pdfModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "i1", toolName: "pdf_info", input: {} }] },
			{ toolCalls: [{ toolCallId: "e1", toolName: "pdf_extract", input: { pages: "1-3" } }] },
			{ text: "A toy aligner; two figures (p. 1, p. 2)." },
		]);
		try { await runner.runJob(pdfJob.id); } finally { pdfModelOverride.current = undefined; }
		await waitFor(() => chatPaperKey(first.id) === key && readManifest(key)?.figures !== undefined, 20_000, "the session to adopt its paper");
		assert.equal(readManifest(key)?.figures?.length, 2, "figure pages were collected in the background");

		const dataJob = jobStore.createJob({ kind: "dataset", chatId: first.id, toolCallId: "call-data", input: { title: "Toy alignment data", brief: "b" } });
		createdJobs.push(dataJob.id);
		demoModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_script", input: { code: GENERATOR } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "run_script", input: {} }] },
			{ text: "One alignment story." },
		]);
		try { await runner.runJob(dataJob.id); } finally { demoModelOverride.current = undefined; }
		const made = jobStore.getJob(dataJob.id)!;
		assert.equal(made.status, "done", made.error);
		assert.equal((made.result as ToyDataResult).files.length, 6);
		assert.equal((made.result as ToyDataResult).reused, undefined);
		assert.equal(chatToyData(first.id)?.files.length, 6);
		assert.ok(fs.existsSync(path.join(toyDir(key), "toy_reads.fastq")));
		assert.ok((made.usage?.steps ?? 0) >= 3, "the maker's model calls are accounted for");

		const served = await getPaperData(new Request("http://test/x"), { params: Promise.resolve({ id: first.id, file: "toy_reads.fastq" }) });
		assert.equal(served.status, 200);
		assert.match(await served.text(), /^@read_1\n/);
		assert.equal((await getPaperData(new Request("http://test/x"), { params: Promise.resolve({ id: first.id, file: "../manifest.json" }) })).status, 404);

		// Session 2 on the same file: same cache, no model call at all.
		const second = chatStore.createChat("Test: cache session 2", "paper");
		createdChats.push(second.id);
		setChatPaper(second.id, key);
		assert.equal(chatCacheKey(second.id), key);
		const reuseJob = jobStore.createJob({ kind: "dataset", chatId: second.id, toolCallId: "call-data-2", input: { title: "Again", brief: "b" } });
		createdJobs.push(reuseJob.id);
		await runner.runJob(reuseJob.id); // no demoModelOverride: a model call would refuse the job
		const reused = jobStore.getJob(reuseJob.id)!;
		assert.equal(reused.status, "done", reused.error);
		assert.equal((reused.result as ToyDataResult).reused, true);
		assert.equal((reused.result as ToyDataResult).files.length, 6);
		assert.equal(reused.usage, undefined, "reuse makes no model call");

		// A Manim scene in that session reads a toy file from data/.
		const scene = [
			"from manim import *",
			"class Explainer(Scene):",
			"    def construct(self):",
			"        first = open('data/toy_reads.fastq').read().splitlines()[0]",
			"        assert first == '@read_1', first",
			"        self.play(Write(Text(first)))",
			"        self.wait(0.3)",
		].join("\n");
		const animJob = jobStore.createJob({ kind: "manim", chatId: second.id, toolCallId: "call-anim", input: { title: "First read", brief: "Show the first read name." } });
		createdJobs.push(animJob.id);
		visualModelOverride.current = scriptedModel([
			{ toolCalls: [{ toolCallId: "w1", toolName: "write_scene", input: { code: scene } }] },
			{ toolCalls: [{ toolCallId: "r1", toolName: "render_scene", input: {} }] },
			{ text: "The first read's name is written out." },
		]);
		try { await runner.runJob(animJob.id); } finally { visualModelOverride.current = undefined; }
		const anim = jobStore.getJob(animJob.id)!;
		assert.equal(anim.status, "done", (anim.result as ManimResult | undefined)?.notes ?? anim.error);
		assert.ok(fs.statSync(path.join(chatRendersDir(second.id), (anim.result as ManimResult).file)).size > 1000);

		// Deleting a session forgets its link but keeps the paper's shared cache.
		forgetChatPaper(second.id);
		assert.equal(chatPaperKey(second.id), null);
		assert.equal(readManifest(key)?.toy?.files.length, 6);
	});
});
