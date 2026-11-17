import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Tool, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { processImage, type ProcessImageResult } from "../image-processing/index.ts";
import { piEngineFor, type PiEngine } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
import { backgroundCaptureStream, createBackgroundCapture } from "../background-capture.ts";
import { workerRequestStream } from "../worker-request-admission.ts";
import type { ManimResult } from "../../core/contracts.ts";
import { ensureRenderEnv, latexAvailable, runProcess, tail } from "./render-env.ts";
import { snippetAround, streamOnce, toolText } from "./visual-maker.ts";

/**
 * papersplainer: the manim-maker sub-agent. Same doctrine as the
 * visual-maker (verify by looking), for motion: it writes ONE Manim scene,
 * renders a fast preview, LOOKS at frames sampled across the clip, and
 * revises until the animation is correct. Only then is the final-quality
 * clip rendered and delivered.
 *
 * The scene is Python written by a model and executed on this computer in
 * the managed Manim environment. It runs in a throwaway working folder,
 * but it is NOT sandboxed.
 */

export const MANIM_SCENE_CLASS = "Explainer";

export interface ManimMakerInput {
	title: string;
	brief: string;
}

/** What one render produced. */
export interface ManimRender {
	/** Absolute path of the mp4. */
	video: string;
	durationSec: number;
	/** PNG frames sampled across the clip, with their timestamps. */
	frames: { png: Buffer; atSec: number }[];
}

/** The render seam (tests inject a fake; production runs Manim). */
export interface ManimRenderer {
	/** Null when rendering can work; otherwise why it cannot. */
	prepare(onActivity: (line: string) => void, signal?: AbortSignal): Promise<string | null>;
	render(code: string, quality: "preview" | "final", signal?: AbortSignal): Promise<ManimRender>;
	latex: boolean;
	dispose(): Promise<void>;
}

export interface ManimMakerOptions {
	engine?: PiEngine;
	renderer?: ManimRenderer;
	/** Where the delivered mp4 is written (absolute path). */
	outputPath: string;
	maxIterations?: number;
	onActivity?: (line: string) => void;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	chatId?: string;
}

const instructions = (latex: boolean): string => `You are an animation maker for scientific explanations. You receive a brief describing ONE short
animation that explains an idea from a research paper (an algorithm stepping through data, a pipeline, a
transformation, a comparison that unfolds over time), and you return ONE correct, readable Manim animation.
You never see the paper or the conversation; the brief is everything you know.

You do NOT decide what to show; the guide already decided. Your job is faithful, precise animation, and above
everything CORRECTNESS: the animation must not assert anything false. A wrong value in a matrix cell, an arrow
to the wrong element, steps shown out of order are failures even when the clip renders cleanly.

You write Python for Manim Community Edition. Your three tools:
- write_scene({ code }): write the complete Python source (overwrites the previous version).
- edit_scene({ old_text, new_text }): exact-match replacement in the current source; old_text must appear
  EXACTLY ONCE. For anything beyond a one-spot fix, write_scene the whole file again.
- render_scene({}): render a fast preview. Frames sampled across the clip arrive as images right after the
  tool result, each labelled with its timestamp. A render error returns the traceback instead.

Scene requirements:
- Start with \`from manim import *\` and define exactly one scene: \`class ${MANIM_SCENE_CLASS}(Scene):\` with
  a \`construct(self)\` method. No other scene classes, no \`if __name__\` block, no config changes.
- Standard library and numpy only. No file, network, or subprocess access, and no external assets
  (images, SVG files, fonts, sounds).
- Length: aim for 10 to 40 seconds. Use self.wait() so each step can be read.
- Dark default background, large text (font_size 28 or more for labels), at most two accent colors.
- Keep everything inside the frame (about 14 units wide by 8 high). Nothing may overlap unless intended.
- One idea, fewest elements. Animate only what the brief specifies; never invent data or steps.
${latex
	? "- LaTeX is installed: MathTex and Tex are available for formulas. Use Text for ordinary words."
	: "- LaTeX is NOT installed on this computer: never use MathTex, Tex, or anything that needs LaTeX\n  (including DecimalNumber and Axes numbers with default labels). Write formulas with Text, using Unicode\n  symbols and subscripts where needed."}

THE ONE RULE THAT MATTERS MOST: verify by looking. A successful render only proves the code ran. Look at
every sampled frame and check:
- Is each value, label, and position correct for that moment of the animation?
- Is anything clipped, overlapping, too small, or left on screen after it should have gone?
- Does the sequence of frames tell the brief's story in the right order?

Workflow: plan the layout and timeline, write_scene, render_scene, LOOK critically, fix, and re-render until
correct. Never finish without having looked at a render of your FINAL code.

Your FINAL message: 2 to 4 sentences of notes for the guide: what the animation shows, in order, and any
caveats. NEVER the code itself. If you cannot make a correct animation of the brief, say exactly that and why.`;

export function createManimTools(): Record<string, Tool> {
	return {
		write_scene: {
			name: "write_scene",
			description: "Write the complete Manim Python source for the animation (overwrites any previous version).",
			parameters: Type.Object({
				code: Type.String({ description: `Complete Python source defining class ${MANIM_SCENE_CLASS}(Scene).` }),
			}),
		},
		edit_scene: {
			name: "edit_scene",
			description:
				"Replace one exact spot in the current source: old_text must appear EXACTLY ONCE and is replaced by new_text. Call write_scene first.",
			parameters: Type.Object({
				old_text: Type.String({ description: "The exact text to replace; must match exactly once." }),
				new_text: Type.String({ description: "The replacement text." }),
			}),
		},
		render_scene: {
			name: "render_scene",
			description: "Render a fast preview of the current source and show you frames sampled across the clip. No arguments.",
			parameters: Type.Object({}),
		},
	};
}

/** Why a source cannot be rendered as is (null = acceptable). */
export function sceneProblem(code: string): string | null {
	if (!new RegExp(`^class\\s+${MANIM_SCENE_CLASS}\\s*\\(`, "m").test(code))
		return `the source must define \`class ${MANIM_SCENE_CLASS}(Scene):\``;
	if (!/^\s*(from\s+manim\s+import|import\s+manim)/m.test(code)) return "the source must import manim";
	return null;
}

const LOOK_MESSAGE =
	"Here are frames sampled across the preview, in order. Inspect each one critically (values, positions, clipping, overlap, order):";
const UNLOOKED_FINISH_MESSAGE =
	"You finished without looking at a render of your final code. Above are frames from its render. If the animation is correct and clean, reply with just your notes; otherwise fix it and render again.";

export async function runManimMaker(input: ManimMakerInput, opts: ManimMakerOptions): Promise<ManimResult> {
	const title = input.title.trim() || "Animation";
	const brief = input.brief.trim() || "(no brief)";
	const maxIterations = opts.maxIterations ?? 10;
	const failed = (reason: string): ManimResult => ({ title, file: "", notes: `FAILED: ${reason}` });
	const renderer = opts.renderer ?? createManimRenderer();

	try {
		const unavailable = await renderer.prepare(opts.onActivity ?? (() => {}), opts.abortSignal);
		if (unavailable) return failed(unavailable);

		const toolDeclarations = Object.values(createManimTools());
		const engine = opts.engine ?? piEngineFor("visualMaker");
		const sessionId = randomUUID();
		const capture = createBackgroundCapture({ role: "visualMaker", runId: sessionId, sourceId: opts.chatId });
		const streamEngine = { ...engine, streamFn: backgroundCaptureStream(workerRequestStream(engine.streamFn), capture) };
		const systemPrompt = instructions(renderer.latex);
		let messages: Message[] = [
			{
				role: "user",
				content: [
					"Brief for ONE animation (from the guide, verbatim; it is everything you know):",
					`Title: ${title}`,
					brief,
					"",
					"Write the scene, render it, look at the frames, iterate until correct, then finish with your notes.",
				].join("\n"),
				timestamp: Date.now(),
			},
		];
		let currentCode: string | null = null;
		let renderedCode: string | null = null;
		let finalText = "";
		let captureError: unknown;

		const look = async (render: ManimRender, lead: string): Promise<Message> => {
			const content: Extract<Message, { role: "user" }>["content"] = [
				{ type: "text", text: `${lead}\nClip length: ${render.durationSec.toFixed(1)} s.` },
			];
			for (const frame of render.frames) {
				const image: ProcessImageResult = await processImage(frame.png, "image/png", {
					resizeOptions: engine.model.inputLimits?.images?.resize,
				});
				if (!image.ok) throw new Error(image.message);
				(content as unknown[]).push({ type: "text", text: `Frame at ${frame.atSec.toFixed(1)} s:` });
				(content as unknown[]).push({ type: "image", data: image.data, mimeType: image.mimeType });
			}
			return { role: "user", content, timestamp: Date.now() };
		};

		const deliver = async (): Promise<ManimResult> => {
			if (!currentCode) return failed(`the maker never wrote a scene.${finalText ? ` (${finalText.slice(0, 300)})` : ""}`);
			opts.onActivity?.("rendering final animation");
			const final = await renderer.render(currentCode, "final", opts.abortSignal);
			await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
			await fs.copyFile(final.video, opts.outputPath);
			return { title, file: path.basename(opts.outputPath), durationSec: final.durationSec, notes: finalText || undefined };
		};

		try {
			for (let iteration = 0; iteration < maxIterations; iteration++) {
				const result = await streamOnce(
					streamEngine,
					systemPrompt,
					messages,
					toolDeclarations,
					sessionId,
					engine.level,
					opts.abortSignal,
					opts.chatId ? providerEventObserver(opts.chatId, "job:visualMaker") : undefined,
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
					if (currentCode && renderedCode !== currentCode) {
						let render: ManimRender;
						try {
							opts.onActivity?.("render_scene: inspecting final preview");
							render = await renderer.render(currentCode, "preview", opts.abortSignal);
						} catch (err) {
							if (opts.abortSignal?.aborted) throw err;
							messages = [...messages, {
								role: "user",
								content: `Your final code does not render:\n${errorText(err)}\nFix it with write_scene or edit_scene and render again.`,
								timestamp: Date.now(),
							}];
							continue;
						}
						renderedCode = currentCode;
						messages = [...messages, await look(render, UNLOOKED_FINISH_MESSAGE)];
						continue;
					}
					return await deliver();
				}

				const toolResults: ToolResultMessage[] = [];
				let lookMessage: Message | null = null;
				for (const call of toolCalls) {
					if (call.name === "write_scene") {
						const code = (call.arguments as { code?: unknown }).code;
						if (typeof code !== "string" || !code.trim()) {
							toolResults.push(toolText(call.id, call.name, "ERROR: expected the complete Python source in the `code` field."));
							continue;
						}
						const problem = sceneProblem(code);
						if (problem) {
							toolResults.push(toolText(call.id, call.name, `ERROR: ${problem}.`));
							continue;
						}
						currentCode = code;
						opts.onActivity?.(`write_scene: ${code.split("\n").length} lines`);
						toolResults.push(toolText(call.id, call.name, "Saved. Call render_scene to look at it."));
					} else if (call.name === "edit_scene") {
						const edit = call.arguments as { old_text?: unknown; new_text?: unknown };
						if (!currentCode) {
							toolResults.push(toolText(call.id, call.name, "ERROR: nothing to edit; call write_scene first."));
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
						const edited: string = currentCode.replace(edit.old_text, () => edit.new_text as string);
						const problem = sceneProblem(edited);
						if (problem) {
							toolResults.push(toolText(call.id, call.name, `ERROR: edit not applied; ${problem}.`));
							continue;
						}
						currentCode = edited;
						opts.onActivity?.("edit_scene: applied");
						toolResults.push(toolText(call.id, call.name, "OK. Call render_scene to look at the edited scene."));
					} else if (call.name === "render_scene") {
						if (!currentCode) {
							toolResults.push(toolText(call.id, call.name, "ERROR: nothing to render; call write_scene first."));
							continue;
						}
						try {
							opts.onActivity?.("render_scene: rendering preview");
							const render = await renderer.render(currentCode, "preview", opts.abortSignal);
							lookMessage = await look(render, LOOK_MESSAGE);
							renderedCode = currentCode;
							opts.onActivity?.("render_scene: inspecting frames");
							toolResults.push(toolText(call.id, call.name, `Rendered (${render.durationSec.toFixed(1)} s). Frames follow in the next message. Look at them.`));
						} catch (err) {
							if (opts.abortSignal?.aborted) throw err;
							opts.onActivity?.("render_scene: render error");
							toolResults.push(toolText(call.id, call.name, `RENDER ERROR: ${errorText(err)}\nFix the code and render again.`));
						}
					} else {
						toolResults.push(toolText(call.id, call.name, `ERROR: unknown tool "${call.name}". Use write_scene, edit_scene, or render_scene.`));
					}
				}
				for (const toolResult of toolResults) capture?.toolResult(toolResult);
				messages = [...messages, ...toolResults];
				if (lookMessage) messages = [...messages, lookMessage];
			}
			if (currentCode && renderedCode === currentCode) {
				finalText ||= "Iteration limit reached; delivering the last animation the maker looked at.";
				return await deliver();
			}
			return failed(`iteration limit (${maxIterations}) reached without a verified animation.`);
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
		await renderer.dispose().catch(() => {});
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ─── the production renderer ─────────────────────────────────────────────────

/** Samples frames from an mp4 with PyAV (a Manim dependency), so no ffmpeg
 *  install is needed. Prints one JSON line: { duration, frames: [{file, at}] }. */
const FRAME_SCRIPT = `
import json, sys
import av

video, out_dir, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
with av.open(video) as container:
    stream = container.streams.video[0]
    frames = [f for f in container.decode(stream)]
total = len(frames)
if total == 0:
    raise SystemExit("the render produced no frames")
rate = float(stream.average_rate or 15)
duration = total / rate
picks = sorted({min(total - 1, round((i + 0.5) * total / count)) for i in range(count)} | {total - 1})
result = []
for n, index in enumerate(picks):
    name = f"{out_dir}/frame{n}.png"
    frames[index].to_image().save(name)
    result.append({"file": name, "at": index / rate})
print(json.dumps({"duration": duration, "frames": result}))
`;

const PREVIEW_FRAMES = 5;

export function createManimRenderer(): ManimRenderer {
	let python: string | null = null;
	let workDir: string | null = null;
	let renders = 0;
	return {
		latex: latexAvailable(),
		async prepare(onActivity, signal) {
			try {
				python = await ensureRenderEnv("manim", onActivity, signal);
			} catch (err) {
				if (signal?.aborted) throw err;
				return `the Manim environment could not be set up: ${errorText(err)}`;
			}
			workDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-manim-"));
			await fs.writeFile(path.join(workDir, "frames.py"), FRAME_SCRIPT);
			return null;
		},
		async render(code, quality, signal) {
			if (!python || !workDir) throw new Error("the renderer was not prepared");
			const dir = path.join(workDir, `r${renders++}`);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, "scene.py"), code);
			const run = await runProcess(
				python,
				["-m", "manim", "render", quality === "final" ? "-qm" : "-ql", "--disable_caching", "--progress_bar", "none",
					"--media_dir", path.join(dir, "media"), "-o", "clip", "scene.py", MANIM_SCENE_CLASS],
				{ cwd: dir, signal, timeoutMs: quality === "final" ? 15 * 60_000 : 5 * 60_000 },
			);
			if (run.timedOut) throw new Error(`the render timed out (${quality === "final" ? 15 : 5} minutes). Shorten or simplify the animation.`);
			if (run.code !== 0) throw new Error(tail(`${run.stdout}\n${run.stderr}`, 3000));
			const video = await findMp4(path.join(dir, "media"));
			if (!video) throw new Error(`Manim finished but wrote no video. Output:\n${tail(`${run.stdout}\n${run.stderr}`, 1500)}`);
			const framesDir = path.join(dir, "frames");
			await fs.mkdir(framesDir, { recursive: true });
			const sample = await runProcess(python, [path.join(workDir, "frames.py"), video, framesDir, String(PREVIEW_FRAMES)], { signal, timeoutMs: 120_000 });
			if (sample.code !== 0) throw new Error(`sampling frames failed: ${tail(sample.stderr)}`);
			const parsed = JSON.parse(sample.stdout.trim().split("\n").pop() ?? "{}") as { duration: number; frames: { file: string; at: number }[] };
			const frames = await Promise.all(parsed.frames.map(async (f) => ({ png: await fs.readFile(f.file), atSec: f.at })));
			return { video, durationSec: parsed.duration, frames };
		},
		async dispose() {
			if (workDir) await fs.rm(workDir, { recursive: true, force: true });
			workDir = null;
		},
	};
}

async function findMp4(dir: string): Promise<string | null> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".mp4") && !full.includes("partial_movie_files")) return full;
		if (entry.isDirectory() && entry.name !== "partial_movie_files") {
			const nested = await findMp4(full);
			if (nested) return nested;
		}
	}
	return null;
}
