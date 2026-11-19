import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Tool, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PATHS } from "../../../config.ts";
import { piEngineFor, type PiEngine } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
import { backgroundCaptureStream, createBackgroundCapture } from "../background-capture.ts";
import { workerRequestStream } from "../worker-request-admission.ts";
import type { ToyDataResult } from "../../core/contracts.ts";
import { isCacheFileName, type ToyDataFile } from "../../core/paper-cache.ts";
import { ensureRenderEnv, runProcess, tail } from "./render-env.ts";
import { snippetAround, streamOnce, toolText } from "./visual-maker.ts";
import { getHeadless } from "./headless.ts";
import { PythonSandboxTimeout, pythonSandboxAvailable, runSandboxedPython } from "./python-sandbox.ts";

/**
 * papersplainer: the toy-data maker. Given a description of the data a
 * study uses, it writes a small Python generator script, runs it, and has
 * every output file parsed back by a fixed checker (toy-data/checkdata.py)
 * before anything is delivered. The same doctrine as the other makers:
 * never deliver what has not been verified. Here "looking" is parsing.
 *
 * The generator is model-written Python, so it never runs as a process on
 * this computer. It runs in the Python sandbox (python-sandbox.ts): Pyodide
 * inside a headless browser page with no file system and no network. Only
 * the files it wrote come out, as bytes. Two fixed, trusted scripts then
 * run in the managed Python environment: build_h5.py turns the plain HDF5
 * descriptions into real HDF5 files, and checkdata.py parses every file.
 */

const TOY_DATA_DIR = path.join(PATHS.root, "src", "agent", "subagents", "toy-data");
const MAX_FILES = 16;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface ToyDataMakerInput {
	title: string;
	brief: string;
}

export interface CheckedFile extends ToyDataFile {
	problems: string[];
}

/** One run of a generator script. */
export interface ToyDataRun {
	/** Absolute folder holding the files the script wrote. */
	dir: string;
	files: CheckedFile[];
}

/** The execution seam (tests inject a fake; production runs Python). */
export interface ToyDataRunner {
	prepare(onActivity: (line: string) => void, signal?: AbortSignal): Promise<string | null>;
	/** Runs the script and checks its output. Throws with the script's error text when it fails. */
	run(code: string, signal?: AbortSignal): Promise<ToyDataRun>;
	dispose(): Promise<void>;
}

export interface ToyDataMakerOptions {
	engine?: PiEngine;
	runner?: ToyDataRunner;
	/** Folder the delivered files are copied into (absolute; replaced). */
	outputDir: string;
	maxIterations?: number;
	onActivity?: (line: string) => void;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	chatId?: string;
}

const INSTRUCTIONS = `You make small toy datasets that show what a research study's data looks like. You receive a brief describing
the data a paper uses: the file types, what one record holds, and how the method consumes them. You write ONE Python
script that generates a handful of tiny files in those same formats. You never see the paper; the brief is everything
you know.

The point is FORM, not scale or realism: a learner should be able to open each file, see every field a real file has,
and follow one record through the method by hand. So:
- Tiny. A few records per file: 4 to 12 reads, 3 to 6 variants, a 5 by 4 count matrix, 2 or 3 sequences of 30 to 80
  letters. Never thousands of lines.
- Faithful in format. Use the real file extensions and the real layout: header lines, column order, separators,
  required fields. A file a standard parser would reject is a failure.
- Consistent across files. If reads align to a reference, the reference contains those bases at those positions; if
  a matrix has samples, the sample sheet lists the same names. The files must tell one small coherent story.
- Illustrative, never passed off as real. Use obviously toy names (toy_chr1, sample_A, gene_1). Do not invent
  accession numbers, real gene measurements, or results. Fix the random seed so reruns give the same files.
- Do not download anything. The script runs in a sandbox with no network and no access to this computer's files.

Your script:
- Writes every file into the current working directory, with plain file names (no subfolders).
- May use the Python standard library ONLY. numpy, pandas, h5py and every other package are NOT available: use
  lists, the random module, csv, json, struct, gzip.
- For BAM: write the alignments as a SAM file first, then \`from papertoy import sam_to_bam\` and call
  \`sam_to_bam("x.sam", "x.bam")\`. Keep the .sam too; it is the readable twin.
- For HDF5-based formats (.h5, .hdf5, .h5ad, .loom): \`from papertoy import write_h5\` and describe the file; the
  real HDF5 file is then built for you and appears in the report:
    write_h5("toy_cells.h5ad", {
        "X": {"data": [[1, 0, 2], [0, 3, 1]], "dtype": "float32"},
        "obs/_index": {"data": ["cell_1", "cell_2"], "dtype": "str"},
        "var/_index": {"data": ["gene_1", "gene_2", "gene_3"], "dtype": "str"},
    }, attrs={"obs": {"encoding-type": "dataframe"}, "var": {"encoding-type": "dataframe"}})
  Dataset paths with "/" make groups. dtype is one of float32, float64, int8..int64, uint8..uint64, bool, str.
  Follow the format's layout (for .h5ad: X, obs, var at the top level).
- For a format too heavy or proprietary to write for real (CRAM, BCF, .fast5, .pod5, .bigWig, .rds, vendor files): write a
  readable stand-in with an honest name, for example signal_fast5_layout.txt, that lists what the real file contains
  and shows a few example values. Say so in your notes. Never give a stand-in the real extension.
- At most ${MAX_FILES} files, each under ${MAX_FILE_BYTES / 1024} KB.

Your three tools:
- write_script({ code }): write the complete Python script (overwrites the previous version).
- edit_script({ old_text, new_text }): exact-match replacement; old_text must appear EXACTLY ONCE.
- run_script({}): run the script, then parse every file it wrote. You get back, per file: the format detected, what
  was counted, the opening lines, and any PROBLEMS the parser found. A Python error returns the traceback instead.

You are done only when a run of your FINAL script reports no problems. Read each file's opening lines in the report
and check them against the brief: right fields, right order, consistent across files.

Your FINAL message: for each file, one line saying what it stands for in the study and how the method uses it, plus
any stand-ins or caveats. NEVER the script itself. If you cannot make faithful files for the brief, say exactly that
and why.`;

export function createToyDataTools(): Record<string, Tool> {
	return {
		write_script: {
			name: "write_script",
			description: "Write the complete Python generator script (overwrites any previous version).",
			parameters: Type.Object({ code: Type.String({ description: "Complete Python source." }) }),
		},
		edit_script: {
			name: "edit_script",
			description: "Replace one exact spot in the current script: old_text must appear EXACTLY ONCE. Call write_script first.",
			parameters: Type.Object({
				old_text: Type.String({ description: "The exact text to replace; must match exactly once." }),
				new_text: Type.String({ description: "The replacement text." }),
			}),
		},
		run_script: {
			name: "run_script",
			description: "Run the current script and parse every file it wrote. No arguments.",
			parameters: Type.Object({}),
		},
	};
}

/** Problems with a run as a whole (beyond per-file parse problems). Pure. */
export function runProblems(files: readonly CheckedFile[]): string[] {
	const problems: string[] = [];
	if (files.length === 0) problems.push("the script wrote no files into the working directory");
	if (files.length > MAX_FILES) problems.push(`${files.length} files written; the limit is ${MAX_FILES}`);
	for (const file of files) {
		if (!isCacheFileName(file.name)) problems.push(`${JSON.stringify(file.name)}: use plain file names (letters, digits, dot, dash, underscore)`);
		if (file.bytes > MAX_FILE_BYTES) problems.push(`${file.name}: ${Math.round(file.bytes / 1024)} KB; keep each file under ${MAX_FILE_BYTES / 1024} KB`);
		if (file.bytes === 0) problems.push(`${file.name}: empty file`);
	}
	if (files.reduce((sum, f) => sum + f.bytes, 0) > MAX_TOTAL_BYTES) problems.push("the files total more than 2 MB; a toy dataset should be tiny");
	return problems;
}

/** The report the model reads after a run. Pure. */
export function runReport(files: readonly CheckedFile[]): { text: string; clean: boolean } {
	const overall = runProblems(files);
	const withProblems = files.filter((f) => f.problems.length > 0);
	const clean = overall.length === 0 && withProblems.length === 0;
	const lines: string[] = [clean ? "Ran. Every file parsed without problems." : "Ran, but there are PROBLEMS to fix:"];
	for (const problem of overall) lines.push(`- ${problem}`);
	for (const file of files) {
		lines.push("", `### ${file.name} (${file.format}; ${file.summary || "no summary"}; ${file.bytes} bytes)`);
		if (file.problems.length > 0) lines.push(...file.problems.map((p) => `PROBLEM: ${p}`));
		else if (!file.checked) lines.push("(format not checked by the parser: make sure this is an honestly named stand-in or a format you verified by reading it)");
		lines.push(file.preview);
	}
	if (clean) lines.push("", "Check the opening lines against the brief. If they are right, finish with your notes; otherwise fix the script and run again.");
	return { text: lines.join("\n"), clean };
}

export async function runToyDataMaker(input: ToyDataMakerInput, opts: ToyDataMakerOptions): Promise<ToyDataResult> {
	const title = input.title.trim() || "Toy dataset";
	const brief = input.brief.trim() || "(no brief)";
	const maxIterations = opts.maxIterations ?? 12;
	const failed = (reason: string): ToyDataResult => ({ title, files: [], notes: `FAILED: ${reason}` });
	const runner = opts.runner ?? createToyDataRunner();

	try {
		const unavailable = await runner.prepare(opts.onActivity ?? (() => {}), opts.abortSignal);
		if (unavailable) return failed(unavailable);

		const toolDeclarations = Object.values(createToyDataTools());
		const engine = opts.engine ?? piEngineFor("demoBuilder");
		const sessionId = randomUUID();
		const capture = createBackgroundCapture({ role: "demoBuilder", runId: sessionId, sourceId: opts.chatId });
		const streamEngine = { ...engine, streamFn: backgroundCaptureStream(workerRequestStream(engine.streamFn), capture) };
		let messages: Message[] = [
			{
				role: "user",
				content: [
					"Brief for ONE toy dataset (from the guide, verbatim; it is everything you know):",
					`Title: ${title}`,
					brief,
					"",
					"Write the generator script, run it, read the report, fix any problems, then finish with your notes.",
				].join("\n"),
				timestamp: Date.now(),
			},
		];
		let currentCode: string | null = null;
		/** The script of the most recent CLEAN run, and what it produced. */
		let verified: { code: string; run: ToyDataRun } | null = null;
		let finalText = "";
		let captureError: unknown;

		const deliver = async (run: ToyDataRun): Promise<ToyDataResult> => {
			await fs.rm(opts.outputDir, { recursive: true, force: true });
			await fs.mkdir(opts.outputDir, { recursive: true });
			for (const file of run.files) await fs.copyFile(path.join(run.dir, file.name), path.join(opts.outputDir, file.name));
			return {
				title,
				files: run.files.map(({ problems: _problems, ...file }) => file),
				notes: finalText || undefined,
			};
		};

		const attempt = async (): Promise<{ text: string; clean: boolean }> => {
			opts.onActivity?.("run_script: running generator");
			const run = await runner.run(currentCode!, opts.abortSignal);
			const report = runReport(run.files);
			verified = report.clean ? { code: currentCode!, run } : null;
			opts.onActivity?.(report.clean ? `run_script: ${run.files.length} file(s) checked` : "run_script: problems found");
			return report;
		};

		try {
			for (let iteration = 0; iteration < maxIterations; iteration++) {
				const result = await streamOnce(
					streamEngine,
					INSTRUCTIONS,
					messages,
					toolDeclarations,
					sessionId,
					engine.level,
					opts.abortSignal,
					opts.chatId ? providerEventObserver(opts.chatId, "job:demoBuilder") : undefined,
					capture,
				);
				opts.onUsage?.(result.usage);
				messages = [...messages, result];

				const toolCalls = result.content.filter((c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall");
				if (toolCalls.length === 0) {
					finalText = result.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("")
						.trim();
					if (!currentCode) return failed(`the maker never wrote a script.${finalText ? ` (${finalText.slice(0, 300)})` : ""}`);
					const current = verified as { code: string; run: ToyDataRun } | null;
					if (current && current.code === currentCode) return await deliver(current.run);
					// Doctrine gate: the final script has not had a clean run. Run it now.
					let report: { text: string; clean: boolean };
					try {
						report = await attempt();
					} catch (err) {
						if (opts.abortSignal?.aborted) throw err;
						report = { text: `SCRIPT ERROR:\n${errorText(err)}`, clean: false };
					}
					messages = [...messages, {
						role: "user",
						content: `You finished without a clean run of your final script. Its run:\n\n${report.text}\n\n` +
							(report.clean ? "If the files are right, reply with just your notes." : "Fix the script and run it again."),
						timestamp: Date.now(),
					}];
					continue;
				}

				const toolResults: ToolResultMessage[] = [];
				for (const call of toolCalls) {
					if (call.name === "write_script") {
						const code = (call.arguments as { code?: unknown }).code;
						if (typeof code !== "string" || !code.trim()) {
							toolResults.push(toolText(call.id, call.name, "ERROR: expected the complete Python source in the `code` field."));
							continue;
						}
						currentCode = code;
						opts.onActivity?.(`write_script: ${code.split("\n").length} lines`);
						toolResults.push(toolText(call.id, call.name, "Saved. Call run_script to generate and check the files."));
					} else if (call.name === "edit_script") {
						const edit = call.arguments as { old_text?: unknown; new_text?: unknown };
						if (!currentCode) {
							toolResults.push(toolText(call.id, call.name, "ERROR: nothing to edit; call write_script first."));
							continue;
						}
						if (typeof edit.old_text !== "string" || typeof edit.new_text !== "string" || !edit.old_text) {
							toolResults.push(toolText(call.id, call.name, "ERROR: expected old_text (non-empty) and new_text strings."));
							continue;
						}
						const occurrences = currentCode.split(edit.old_text).length - 1;
						if (occurrences !== 1) {
							toolResults.push(toolText(call.id, call.name, occurrences === 0
								? `ERROR: old_text not found. Closest line for reference:\n${snippetAround(currentCode, edit.old_text)}`
								: `ERROR: old_text appears ${occurrences} times; it must match EXACTLY ONCE.`));
							continue;
						}
						currentCode = currentCode.replace(edit.old_text, () => edit.new_text as string);
						opts.onActivity?.("edit_script: applied");
						toolResults.push(toolText(call.id, call.name, "OK. Call run_script to generate and check the files."));
					} else if (call.name === "run_script") {
						if (!currentCode) {
							toolResults.push(toolText(call.id, call.name, "ERROR: nothing to run; call write_script first."));
							continue;
						}
						try {
							toolResults.push(toolText(call.id, call.name, (await attempt()).text));
						} catch (err) {
							if (opts.abortSignal?.aborted) throw err;
							opts.onActivity?.("run_script: script error");
							toolResults.push(toolText(call.id, call.name, `SCRIPT ERROR:\n${errorText(err)}\nFix the script and run it again.`));
						}
					} else {
						toolResults.push(toolText(call.id, call.name, `ERROR: unknown tool "${call.name}". Use write_script, edit_script, or run_script.`));
					}
				}
				for (const toolResult of toolResults) capture?.toolResult(toolResult);
				messages = [...messages, ...toolResults];
			}
			const last = verified as { code: string; run: ToyDataRun } | null;
			if (last && last.code === currentCode) {
				finalText ||= "Iteration limit reached; delivering the last dataset that passed every check.";
				return await deliver(last.run);
			}
			return failed(`iteration limit (${maxIterations}) reached without a dataset that passed its checks.`);
		} catch (err) {
			captureError = err;
			throw err;
		} finally {
			capture?.finish(captureError);
		}
	} catch (err) {
		if (opts.abortSignal?.aborted) throw err;
		return failed(`the maker crashed: ${errorText(err)}`);
	} finally {
		await runner.dispose().catch(() => {});
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ─── the production runner ───────────────────────────────────────────────────

const PAPERTOY = path.join(TOY_DATA_DIR, "papertoy.py");

export function createToyDataRunner(): ToyDataRunner {
	let python: string | null = null;
	let workDir: string | null = null;
	let runs = 0;
	return {
		async prepare(onActivity, signal) {
			if (!pythonSandboxAvailable()) return "the Python sandbox files are missing from this install";
			if (!getHeadless().available()) return `the Python sandbox needs the app's browser helper: ${getHeadless().unavailableReason() ?? "unavailable"}`;
			try {
				// Used only by the two fixed scripts (HDF5 builder, format checker).
				python = await ensureRenderEnv("manim", onActivity, signal);
			} catch (err) {
				if (signal?.aborted) throw err;
				return `the Python environment could not be set up: ${errorText(err)}`;
			}
			workDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-toydata-"));
			return null;
		},
		async run(code, signal) {
			if (!python || !workDir) throw new Error("the runner was not prepared");
			const out = path.join(workDir, `r${runs++}`);
			await fs.mkdir(out, { recursive: true });

			// 1. The untrusted script, in the sandbox.
			let result;
			try {
				result = await runSandboxedPython(code, { modules: { "papertoy.py": await fs.readFile(PAPERTOY, "utf-8") }, timeoutMs: 60_000, signal });
			} catch (err) {
				if (err instanceof PythonSandboxTimeout) throw new Error(`${err.message}. A toy dataset should generate in a second or two.`);
				throw err;
			}
			if (result.error) throw new Error(tail(`${result.output}\n${result.error}`, 3000));

			// 2. Its files, written out under names we accept.
			const badName = result.files.find((f) => !isCacheFileName(f.name));
			if (badName) throw new Error(`the script wrote a file named ${JSON.stringify(badName.name)}; use plain file names (letters, digits, dot, dash, underscore)`);
			for (const file of result.files) await fs.writeFile(path.join(out, file.name), file.data);

			// 3. Trusted: build real HDF5 files from the script's descriptions.
			const trusted = { signal, timeoutMs: 120_000, scrubEnv: true };
			let h5Problems: string[] = [];
			if (result.files.some((f) => f.name.endsWith(".h5spec.json"))) {
				const built = await runProcess(python, ["-I", path.join(TOY_DATA_DIR, "build_h5.py"), out], trusted);
				const line = built.stdout.split("\n").find((l) => l.startsWith("PAPERSPLAINER_H5 "));
				if (built.code !== 0 || !line) throw new Error(`building the HDF5 files failed: ${tail(built.stderr || built.stdout, 1500)}`);
				h5Problems = (JSON.parse(line.slice("PAPERSPLAINER_H5 ".length)) as { problems: string[] }).problems;
			}
			if (h5Problems.length > 0) throw new Error(`write_h5 problems:\n${h5Problems.join("\n")}`);

			// 4. Trusted: parse every file back.
			const check = await runProcess(python, ["-I", path.join(TOY_DATA_DIR, "checkdata.py"), out], trusted);
			const line = check.stdout.split("\n").find((l) => l.startsWith("PAPERSPLAINER_CHECK "));
			if (check.code !== 0 || !line) throw new Error(`checking the files failed: ${tail(check.stderr || check.stdout, 1500)}`);
			const parsed = JSON.parse(line.slice("PAPERSPLAINER_CHECK ".length)) as { files: CheckedFile[] };
			return { dir: out, files: parsed.files };
		},
		async dispose() {
			if (workDir) await fs.rm(workDir, { recursive: true, force: true });
			workDir = null;
		},
	};
}
