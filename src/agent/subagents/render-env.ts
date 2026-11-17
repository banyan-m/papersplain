import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";

/**
 * papersplainer: the managed render environments.
 *
 * Manim and Molecular Nodes each get their own Python virtual environment
 * under <data>/render-env/<kind>, created with uv on first use. Two
 * environments, not one: Blender's `bpy` pins its own dependency versions
 * and a joint install is fragile.
 *
 * Overrides (development, tests, or a user who manages Python themselves):
 *   LH_MANIM_PYTHON / LH_MOLECULE_PYTHON  an existing interpreter to use as is
 *   LH_UV                                 the uv executable
 */

export type RenderEnvKind = "manim" | "molecule";

const PACKAGES: Record<RenderEnvKind, string[]> = {
	manim: ["manim"],
	molecule: ["molecularnodes[bpy]"],
};
const PYTHON_VERSION = "3.11";
/** Bump to force a reinstall when PACKAGES changes. */
const ENV_STAMP = "1";

const OVERRIDE_VAR: Record<RenderEnvKind, string> = {
	manim: "LH_MANIM_PYTHON",
	molecule: "LH_MOLECULE_PYTHON",
};

const exe = (name: string): string => (process.platform === "win32" ? `${name}.exe` : name);

function envDir(kind: RenderEnvKind): string {
	return path.join(PATHS.renderEnv, kind);
}

function venvPython(kind: RenderEnvKind): string {
	return process.platform === "win32"
		? path.join(envDir(kind), "Scripts", "python.exe")
		: path.join(envDir(kind), "bin", "python");
}

function readyFile(kind: RenderEnvKind): string {
	return path.join(envDir(kind), ".papersplainer-ready");
}

/** The interpreter for a kind when it is usable right now, else null. */
export function renderPython(kind: RenderEnvKind): string | null {
	const override = process.env[OVERRIDE_VAR[kind]];
	if (override) return fsSync.existsSync(override) ? override : null;
	try {
		if (fsSync.readFileSync(readyFile(kind), "utf-8").trim() !== ENV_STAMP) return null;
	} catch {
		return null;
	}
	return fsSync.existsSync(venvPython(kind)) ? venvPython(kind) : null;
}

export interface RenderEnvStatus {
	manim: { ready: boolean; python: string | null; installing: boolean };
	molecule: { ready: boolean; python: string | null; installing: boolean };
	/** LaTeX on PATH: needed only for typeset formulas in Manim (MathTex). */
	latex: boolean;
	uv: string | null;
}

export function renderEnvStatus(): RenderEnvStatus {
	const one = (kind: RenderEnvKind) => {
		const python = renderPython(kind);
		return { ready: python !== null, python, installing: installs.has(kind) };
	};
	return { manim: one("manim"), molecule: one("molecule"), latex: latexAvailable(), uv: findUv() };
}

function onPath(name: string): string | null {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		const candidate = path.join(dir, exe(name));
		if (fsSync.existsSync(candidate)) return candidate;
	}
	return null;
}

/** True when both `latex` and `dvisvgm` are on PATH (what Manim's MathTex needs). */
export function latexAvailable(): boolean {
	return onPath("latex") !== null && onPath("dvisvgm") !== null;
}

function localUv(): string {
	return path.join(PATHS.renderEnv, "bin", exe("uv"));
}

function findUv(): string | null {
	const override = process.env.LH_UV;
	if (override && fsSync.existsSync(override)) return override;
	if (fsSync.existsSync(localUv())) return localUv();
	return onPath("uv");
}

export interface ProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Run a program to completion, capturing bounded output. Never throws for a
 *  non-zero exit; throws AbortError when the signal fires. */
export function runProcess(
	command: string,
	args: string[],
	opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		opts.signal?.throwIfAborted();
		const child = spawn(command, args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const LIMIT = 200_000;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const keepTail = (current: string, chunk: Buffer): string => {
			const next = current + chunk.toString("utf-8");
			return next.length > LIMIT ? next.slice(next.length - LIMIT) : next;
		};
		child.stdout.on("data", (chunk: Buffer) => { stdout = keepTail(stdout, chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = keepTail(stderr, chunk); });
		const timer = opts.timeoutMs
			? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs)
			: undefined;
		const onAbort = () => child.kill("SIGKILL");
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		};
		child.on("error", (err) => { cleanup(); reject(err); });
		child.on("close", (code) => {
			cleanup();
			if (opts.signal?.aborted) {
				const err = new Error("aborted");
				err.name = "AbortError";
				reject(err);
				return;
			}
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

/** The uv release asset for this platform, or null when unsupported. */
export function uvAssetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
	const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
	if (!cpu) return null;
	if (platform === "win32") return `uv-${cpu}-pc-windows-msvc.zip`;
	if (platform === "darwin") return `uv-${cpu}-apple-darwin.tar.gz`;
	if (platform === "linux") return `uv-${cpu}-unknown-linux-gnu.tar.gz`;
	return null;
}

/** Download uv into the render-env folder (used only when uv is not installed). */
async function downloadUv(onActivity: (line: string) => void, signal?: AbortSignal): Promise<string> {
	const asset = uvAssetName();
	if (!asset) throw new Error(`no uv build for ${process.platform}/${process.arch}; install uv yourself and set LH_UV`);
	onActivity("downloading uv");
	const res = await fetch(`https://github.com/astral-sh/uv/releases/latest/download/${asset}`, { signal });
	if (!res.ok) throw new Error(`downloading uv failed: HTTP ${res.status}`);
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lh-uv-"));
	try {
		const archive = path.join(tmp, asset);
		await fs.writeFile(archive, Buffer.from(await res.arrayBuffer()));
		// bsdtar (Windows 10+) and GNU tar both unpack these with -xf.
		const unpack = await runProcess("tar", ["-xf", archive, "-C", tmp], { signal, timeoutMs: 120_000 });
		if (unpack.code !== 0) throw new Error(`unpacking uv failed: ${unpack.stderr.slice(-400)}`);
		const found = await findFile(tmp, exe("uv"));
		if (!found) throw new Error("the uv download did not contain the uv executable");
		await fs.mkdir(path.dirname(localUv()), { recursive: true });
		await fs.copyFile(found, localUv());
		if (process.platform !== "win32") await fs.chmod(localUv(), 0o755);
		return localUv();
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

async function findFile(dir: string, name: string): Promise<string | null> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name === name) return full;
		if (entry.isDirectory()) {
			const nested = await findFile(full, name);
			if (nested) return nested;
		}
	}
	return null;
}

const installs = new Map<RenderEnvKind, Promise<string>>();

/** Return the interpreter for a kind, installing its environment first when
 *  needed. Concurrent callers share one install. */
export function ensureRenderEnv(
	kind: RenderEnvKind,
	onActivity: (line: string) => void = () => {},
	signal?: AbortSignal,
): Promise<string> {
	const ready = renderPython(kind);
	if (ready) return Promise.resolve(ready);
	const override = process.env[OVERRIDE_VAR[kind]];
	if (override) return Promise.reject(new Error(`${OVERRIDE_VAR[kind]} points at ${override}, which does not exist`));
	const running = installs.get(kind);
	if (running) {
		onActivity(`installing ${kind} environment`);
		return running;
	}
	const install = installEnv(kind, onActivity, signal).finally(() => installs.delete(kind));
	installs.set(kind, install);
	return install;
}

async function installEnv(kind: RenderEnvKind, onActivity: (line: string) => void, signal?: AbortSignal): Promise<string> {
	const uv = findUv() ?? (await downloadUv(onActivity, signal));
	const dir = envDir(kind);
	await fs.mkdir(PATHS.renderEnv, { recursive: true });
	await fs.rm(readyFile(kind), { force: true });
	onActivity(`creating ${kind} Python environment`);
	const venv = await runProcess(uv, ["venv", "--python", PYTHON_VERSION, "--allow-existing", dir], { signal, timeoutMs: 10 * 60_000 });
	if (venv.code !== 0) throw new Error(`creating the ${kind} environment failed: ${tail(venv.stderr)}`);
	onActivity(`installing ${PACKAGES[kind].join(", ")} (first run, this can take several minutes)`);
	const pip = await runProcess(uv, ["pip", "install", "--python", venvPython(kind), ...PACKAGES[kind]], { signal, timeoutMs: 30 * 60_000 });
	if (pip.code !== 0) throw new Error(`installing ${PACKAGES[kind].join(", ")} failed: ${tail(pip.stderr)}`);
	await fs.writeFile(readyFile(kind), ENV_STAMP);
	return venvPython(kind);
}

export function tail(text: string, chars = 1200): string {
	const trimmed = text.trim();
	return trimmed.length > chars ? `…${trimmed.slice(-chars)}` : trimmed;
}

/** The folder a chat's rendered files live in. */
export function chatRendersDir(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error("invalid chat id");
	return path.join(PATHS.renders, chatId);
}
