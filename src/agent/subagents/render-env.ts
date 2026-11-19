import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";

/**
 * papersplainer: the managed render environments.
 *
 * Manim gets its own Python environment under <data>/render-env/manim.
 * On Windows it is a virtual environment created with uv: every package
 * Manim needs has a prebuilt Windows wheel. On macOS one does not: pycairo
 * ships no macOS wheel, and building it needs a compiler, pkg-config and
 * cairo, which an ordinary Mac lacks. So on macOS the base (Python plus a
 * prebuilt pycairo and its cairo libraries) comes from conda-forge via
 * micromamba, a single downloaded binary, and uv installs the rest on top. The app sets it up on first
 * launch (see app/api/render-env); a render that arrives before that
 * finishes waits for the same install. After installing, parts Manim's
 * Cairo renderer never uses are removed to save disk space (see trimEnv).
 *
 * Overrides (development, tests, or a user who manages Python themselves):
 *   LH_MANIM_PYTHON  an existing interpreter to use as is
 *   LH_UV            the uv executable
 */

export type RenderEnvKind = "manim";

const PACKAGES: Record<RenderEnvKind, string[]> = {
	// h5py (about 15 MB) lets toy datasets include real HDF5 / AnnData-layout files.
	manim: ["manim", "h5py"],
};
const PYTHON_VERSION = "3.11";
/** Bump to force a reinstall when PACKAGES changes. */
const ENV_STAMP = "4";

const OVERRIDE_VAR: Record<RenderEnvKind, string> = {
	manim: "LH_MANIM_PYTHON",
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
	/** LaTeX on PATH: needed only for typeset formulas in Manim (MathTex). */
	latex: boolean;
	uv: string | null;
}

export function renderEnvStatus(): RenderEnvStatus {
	const one = (kind: RenderEnvKind) => {
		const python = renderPython(kind);
		return { ready: python !== null, python, installing: installs.has(kind) };
	};
	return { manim: one("manim"), latex: latexAvailable(), uv: findUv() };
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

/** Environment variables a model-written script is allowed to inherit: what
 *  Python, LaTeX and font lookup need to run, and nothing else. API keys,
 *  access tokens and the app's own settings never reach the script. */
const ENV_ALLOWLIST = new Set([
	"PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
	"HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
	"PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
	"XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "FONTCONFIG_PATH", "FONTCONFIG_FILE",
	"NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
]);

/** process.env reduced to ENV_ALLOWLIST (names compared case-insensitively,
 *  as Windows does; TeX's own TEXMF* variables are kept too). Pure given the input. */
export function scrubbedEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const upper = name.toUpperCase();
		if (ENV_ALLOWLIST.has(upper) || upper.startsWith("TEXMF")) out[name] = value;
	}
	return out;
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
	opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string>; scrubEnv?: boolean } = {},
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		opts.signal?.throwIfAborted();
		const child = spawn(command, args, {
			cwd: opts.cwd,
			env: { ...(opts.scrubEnv ? scrubbedEnv() : process.env), ...opts.env } as NodeJS.ProcessEnv,
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
		// Windows 10+ ships bsdtar, which unpacks .zip; name it by full path so a
		// GNU tar earlier on PATH (Git for Windows) is never picked instead.
		const tarBinary = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
		const unpack = await runProcess(tarBinary, ["-xf", archive, "-C", tmp], { signal, timeoutMs: 120_000 });
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

/** Platforms where the environment's base must come from conda-forge. */
export function needsCondaBase(platform: NodeJS.Platform = process.platform): boolean {
	// LH_CONDA_BASE=1 forces it elsewhere (used to exercise this path off macOS).
	return platform === "darwin" || process.env.LH_CONDA_BASE === "1";
}

/** The micromamba release asset for this platform, or null when unsupported. */
export function micromambaAssetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
	if (platform === "darwin") return arch === "arm64" ? "micromamba-osx-arm64" : arch === "x64" ? "micromamba-osx-64" : null;
	if (platform === "linux") return arch === "x64" ? "micromamba-linux-64" : arch === "arm64" ? "micromamba-linux-aarch64" : null;
	return null;
}

/** conda-forge packages for the base: Python and the one library with no wheel. */
const CONDA_BASE = [`python=${PYTHON_VERSION}`, "pycairo"];

/** Create the environment's base from conda-forge with a downloaded micromamba. */
async function createCondaBase(dir: string, onActivity: (line: string) => void, signal?: AbortSignal): Promise<void> {
	const asset = micromambaAssetName();
	if (!asset) throw new Error(`no micromamba build for ${process.platform}/${process.arch}`);
	const work = path.join(PATHS.renderEnv, "mamba");
	await fs.rm(work, { recursive: true, force: true });
	await fs.mkdir(work, { recursive: true });
	try {
		onActivity("downloading micromamba");
		const res = await fetch(`https://github.com/mamba-org/micromamba-releases/releases/latest/download/${asset}`, { signal });
		if (!res.ok) throw new Error(`downloading micromamba failed: HTTP ${res.status}`);
		const micromamba = path.join(work, "micromamba");
		await fs.writeFile(micromamba, Buffer.from(await res.arrayBuffer()));
		await fs.chmod(micromamba, 0o755);
		onActivity("creating Python environment with prebuilt graphics libraries");
		await fs.rm(dir, { recursive: true, force: true });
		const create = await runProcess(
			micromamba,
			["create", "-y", "-q", "-p", dir, "-c", "conda-forge", "--override-channels", ...CONDA_BASE],
			{ signal, timeoutMs: 20 * 60_000, env: { MAMBA_ROOT_PREFIX: path.join(work, "root"), CONDA_PKGS_DIRS: path.join(work, "pkgs") } },
		);
		if (create.code !== 0) throw new Error(`creating the Python environment failed: ${tail(create.stderr || create.stdout)}`);
	} finally {
		// The installer and its package cache are not needed once the environment exists.
		await fs.rm(work, { recursive: true, force: true });
	}
}

/** Shared libraries in a conda base that the cairo binding never needs
 *  (Python's own, and the libraries only Python's standard modules use). */
const NOT_CAIRO_LIBS = /^lib(python|tcl|tk|sqlite|ssl|crypto|ncurses|readline|form|menu|panel|tinfo|icu|stdc\+\+|gomp|gcc_s|quadmath|gfortran|c\+\+)/;

/**
 * Put a prebuilt pycairo into a uv virtual environment: copy the binding
 * (and its package metadata, so pip sees it as installed) from a throwaway
 * conda base, with the shared libraries it loads. The binding finds those
 * through a path relative to itself that resolves to <env>/lib in both
 * layouts, so no file needs rewriting.
 */
async function transplantCairo(base: string, dir: string): Promise<void> {
	const from = await findSitePackages(base);
	const to = await findSitePackages(dir);
	if (!from || !to) throw new Error("could not locate site-packages for the cairo binding");
	let copied = false;
	for (const entry of await fs.readdir(from)) {
		if (entry === "cairo" || /^pycairo-.*\.(dist|egg)-info$/.test(entry)) {
			await fs.cp(path.join(from, entry), path.join(to, entry), { recursive: true, verbatimSymlinks: true });
			copied ||= entry === "cairo";
		}
	}
	if (!copied) throw new Error("the conda base has no cairo binding");
	for (const entry of await fs.readdir(path.join(base, "lib"), { withFileTypes: true })) {
		const shared = /\.dylib$/.test(entry.name) || /\.so(\.\d+)*$/.test(entry.name);
		if (!shared || entry.isDirectory() || NOT_CAIRO_LIBS.test(entry.name)) continue;
		await fs.cp(path.join(base, "lib", entry.name), path.join(dir, "lib", entry.name), { verbatimSymlinks: true, force: true });
	}
}

const IMPORT_CHECK = ["-I", "-c", "import manim, h5py, cairo, manimpango"];

async function installEnv(kind: RenderEnvKind, onActivity: (line: string) => void, signal?: AbortSignal): Promise<string> {
	const existingUv = findUv();
	const uv = existingUv ?? (await downloadUv(onActivity, signal));
	const dir = envDir(kind);
	await fs.mkdir(PATHS.renderEnv, { recursive: true });
	await fs.rm(readyFile(kind), { force: true });
	// Keep uv's Python download inside the app's folder, and its package cache
	// temporary, so removing the app's data removes everything this installed.
	const cache = path.join(PATHS.renderEnv, "uv-cache");
	const uvEnv = { UV_PYTHON_INSTALL_DIR: path.join(PATHS.renderEnv, "python"), UV_CACHE_DIR: cache, UV_LINK_MODE: "copy" };
	const python = venvPython(kind);
	const pipInstall = async (): Promise<void> => {
		onActivity(`installing ${PACKAGES[kind].join(", ")} (first run, this can take several minutes)`);
		const pip = await runProcess(uv, ["pip", "install", "--python", python, ...PACKAGES[kind]], { signal, timeoutMs: 30 * 60_000, env: uvEnv });
		if (pip.code !== 0) throw new Error(`installing ${PACKAGES[kind].join(", ")} failed: ${tail(pip.stderr)}`);
	};
	const imports = () => runProcess(python, IMPORT_CHECK, { signal, timeoutMs: 5 * 60_000, scrubEnv: true });
	try {
		onActivity(`creating ${kind} Python environment`);
		await fs.rm(dir, { recursive: true, force: true });
		const venv = await runProcess(uv, ["venv", "--python", PYTHON_VERSION, dir], { signal, timeoutMs: 10 * 60_000, env: uvEnv });
		if (venv.code !== 0) throw new Error(`creating the ${kind} environment failed: ${tail(venv.stderr)}`);
		let conda: "none" | "cairo-only" | "full" = "none";
		if (needsCondaBase()) {
			// Light route: a small uv environment plus only the prebuilt cairo binding.
			const base = path.join(PATHS.renderEnv, "conda-base");
			try {
				await createCondaBase(base, onActivity, signal);
				await transplantCairo(base, dir);
				conda = "cairo-only";
			} finally {
				await fs.rm(base, { recursive: true, force: true });
			}
		}
		await pipInstall();
		let check = await imports();
		if (check.code !== 0 && conda === "cairo-only") {
			// Heavier but self-consistent route: the whole base from conda-forge.
			onActivity("retrying with a full prebuilt base");
			await createCondaBase(dir, onActivity, signal);
			await pipInstall();
			check = await imports();
			conda = "full";
		}
		if (check.code !== 0) throw new Error(`the ${kind} environment does not import after install: ${tail(check.stderr)}`);
		onActivity("removing unused parts");
		await trimEnv(dir);
		const after = await imports();
		if (after.code !== 0) throw new Error(`the ${kind} environment does not import after trimming: ${tail(after.stderr)}`);
		await fs.writeFile(readyFile(kind), ENV_STAMP);
		onActivity(`environment ready (${conda === "none" ? "wheels only" : conda === "cairo-only" ? "prebuilt cairo binding added" : "full prebuilt base"})`);
		return python;
	} finally {
		await fs.rm(path.join(PATHS.renderEnv, "conda-base"), { recursive: true, force: true });
		await fs.rm(cache, { recursive: true, force: true });
		// The installer is only needed again for a reinstall, and is quick to fetch.
		if (!existingUv) await fs.rm(path.dirname(localUv()), { recursive: true, force: true });
	}
}

/** Packages Manim installs but its Cairo renderer never loads (OpenGL maths). */
const UNUSED_PACKAGES = ["pyglm", "glm"];

/** Remove what a render never needs: the libraries' own test suites and the
 *  OpenGL-only packages. Measured on Linux: about 394 MB down to about 325 MB. */
export async function trimEnv(envDir: string): Promise<void> {
	// A conda base also carries development files a render never needs.
	for (const extra of ["include", path.join("share", "doc"), path.join("share", "man"), path.join("share", "gtk-doc"), path.join("share", "info"), "man"]) {
		await fs.rm(path.join(envDir, extra), { recursive: true, force: true });
	}
	try {
		for (const entry of await fs.readdir(path.join(envDir, "lib"))) {
			if (entry.endsWith(".a")) await fs.rm(path.join(envDir, "lib", entry), { force: true });
		}
	} catch { /* no lib folder (Windows) */ }
	const sitePackages = await findSitePackages(envDir);
	if (!sitePackages) return;
	for (const name of UNUSED_PACKAGES) await fs.rm(path.join(sitePackages, name), { recursive: true, force: true });
	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries: fsSync.Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			if (entry.name === "tests" || entry.name === "test") await fs.rm(full, { recursive: true, force: true });
			else if (depth < 6) await walk(full, depth + 1);
		}
	};
	await walk(sitePackages, 0);
}

async function findSitePackages(envDir: string): Promise<string | null> {
	const windows = path.join(envDir, "Lib", "site-packages");
	if (fsSync.existsSync(windows)) return windows;
	const lib = path.join(envDir, "lib");
	try {
		for (const entry of await fs.readdir(lib)) {
			const candidate = path.join(lib, entry, "site-packages");
			if (entry.startsWith("python") && fsSync.existsSync(candidate)) return candidate;
		}
	} catch { /* no lib folder */ }
	return null;
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
