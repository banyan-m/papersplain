import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";
import { IsolatedPageCleanupError, withBrowserPage } from "./headless.ts";

/**
 * papersplainer: a real sandbox for model-written Python.
 *
 * The script runs in Pyodide (CPython compiled to WebAssembly) inside a page
 * of the app's own headless browser. That page has no Node access and no
 * file system: Python sees only an in-memory folder. Every network request
 * from the page is refused except for Pyodide's own files, which are served
 * from the app's node_modules by request interception, so nothing is fetched
 * from the internet and nothing can be sent out. The files the script wrote
 * are copied out as bytes when it finishes.
 *
 * Only the standard library is available (no numpy, no native packages).
 */

const PYODIDE_DIR = path.join(PATHS.root, "node_modules", "pyodide");
/** A made-up origin: requests to it never reach the network. */
const ORIGIN = "https://pyodide.sandbox.invalid/";
const SERVED: Record<string, string> = {
	"pyodide.mjs": "text/javascript",
	"pyodide.asm.mjs": "text/javascript",
	"pyodide.asm.wasm": "application/wasm",
	"python_stdlib.zip": "application/zip",
	"pyodide-lock.json": "application/json",
};

export const PYTHON_SANDBOX_LIMITS = { files: 32, totalBytes: 4 * 1024 * 1024, outputChars: 20_000 };

export interface SandboxedPythonResult {
	/** Files the script left in its working folder. */
	files: { name: string; data: Buffer }[];
	/** stdout and stderr, interleaved, capped. */
	output: string;
	/** The Python traceback when the script raised, else null. */
	error: string | null;
}

export interface SandboxedPythonOptions {
	/** Extra importable modules: file name → source (e.g. "papertoy.py"). */
	modules?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** True when the Pyodide runtime files are present (a broken install otherwise). */
export function pythonSandboxAvailable(): boolean {
	return Object.keys(SERVED).every((name) => fs.existsSync(path.join(PYODIDE_DIR, name)));
}

/** What the page may load. Everything else is refused. Pure, exported for tests. */
export function sandboxRequestTarget(url: string): { kind: "page" } | { kind: "asset"; name: string } | { kind: "inline" } | { kind: "refused" } {
	if (url === `${ORIGIN}runner.html`) return { kind: "page" };
	if (url.startsWith(ORIGIN)) {
		const name = url.slice(ORIGIN.length);
		return name in SERVED ? { kind: "asset", name } : { kind: "refused" };
	}
	// In-memory documents only; they carry no way out.
	if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") return { kind: "inline" };
	return { kind: "refused" };
}

interface PageResult {
	files: { name: string; base64: string }[];
	output: string;
	error: string | null;
	fatal?: string;
}

/** Runs INSIDE the page. Kept as source text, not a function: the build
 *  tools add helper calls to compiled functions that do not exist in the page. */
const PAGE_MAIN = String.raw`async (input) => {
	const empty = { files: [], output: "", error: null };
	try {
		const mod = await import(location.origin + "/pyodide.mjs");
		const py = await mod.loadPyodide({ indexURL: location.origin + "/" });
		let output = "";
		py.setStdout({ batched: (line) => { if (output.length < input.limits.outputChars) output += line + "\n"; } });
		py.setStderr({ batched: (line) => { if (output.length < input.limits.outputChars) output += line + "\n"; } });
		py.FS.mkdirTree("/lib/papersplainer");
		for (const [name, source] of Object.entries(input.modules)) py.FS.writeFile("/lib/papersplainer/" + name, source);
		py.FS.mkdirTree("/work");
		py.FS.chdir("/work");
		await py.runPythonAsync("import sys\nsys.path.insert(0, '/lib/papersplainer')\ndel sys");
		let error = null;
		try {
			await py.runPythonAsync(input.code);
		} catch (err) {
			error = String((err && err.message) || err);
		}
		const files = [];
		let total = 0;
		for (const name of py.FS.readdir("/work")) {
			if (name === "." || name === "..") continue;
			const stat = py.FS.stat("/work/" + name);
			if (py.FS.isDir(stat.mode)) return { ...empty, output, fatal: "the script made a folder (" + name + "); write plain files into the working directory" };
			total += stat.size;
			if (files.length >= input.limits.files) return { ...empty, output, fatal: "the script wrote more than " + input.limits.files + " files" };
			if (total > input.limits.totalBytes) return { ...empty, output, fatal: "the script wrote more than " + Math.round(input.limits.totalBytes / 1024 / 1024) + " MB in total" };
			const bytes = py.FS.readFile("/work/" + name);
			let binary = "";
			for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
			files.push({ name, base64: btoa(binary) });
		}
		return { files, output, error };
	} catch (err) {
		return { ...empty, fatal: "the Python sandbox failed to start: " + String((err && err.message) || err) };
	}
}`;

export class PythonSandboxTimeout extends Error {}

type Page = import("puppeteer-core").Page;

/** Run on an owned page (also used by tests with their own browser). */
export async function runSandboxedPythonOnPage(page: Page, code: string, opts: SandboxedPythonOptions = {}): Promise<SandboxedPythonResult> {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const onRequest = (request: import("puppeteer-core").HTTPRequest) => {
		const target = sandboxRequestTarget(request.url());
		const decision =
			target.kind === "page"
				? request.respond({ status: 200, contentType: "text/html", body: "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>" })
				: target.kind === "asset"
					? request.respond({ status: 200, contentType: SERVED[target.name], body: fs.readFileSync(path.join(PYODIDE_DIR, target.name)) })
					: target.kind === "inline"
						? request.continue()
						: request.abort("accessdenied");
		void decision.catch(() => {});
	};
	let timedOut = false;
	const retire = async () => {
		try {
			await page.goto("about:blank", { timeout: 5_000 });
			await page.setRequestInterception(false);
			page.off("request", onRequest);
		} catch (error) {
			throw new IsolatedPageCleanupError("Could not retire the Python sandbox page", { cause: error });
		}
	};
	page.on("request", onRequest);
	await page.setRequestInterception(true);
	let result: PageResult;
	try {
		await page.goto(`${ORIGIN}runner.html`, { waitUntil: "load", timeout: 30_000 });
		let timer: NodeJS.Timeout | undefined;
		const stop = new Promise<never>((_, reject) => {
			timer = setTimeout(() => { timedOut = true; reject(new PythonSandboxTimeout(`the script ran for more than ${Math.round(timeoutMs / 1000)} seconds`)); }, timeoutMs);
			opts.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
		});
		try {
			result = await Promise.race([
				page.evaluate(`(${PAGE_MAIN})(${JSON.stringify({ code, modules: opts.modules ?? {}, limits: PYTHON_SANDBOX_LIMITS })})`) as Promise<PageResult>,
				stop,
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	} catch (err) {
		if (timedOut || opts.signal?.aborted) {
			// The page may be stuck in a loop and cannot be reused: have the owner discard the browser.
			page.off("request", onRequest);
			throw new IsolatedPageCleanupError(err instanceof Error ? err.message : String(err), { cause: err });
		}
		await retire();
		throw err;
	}
	await retire();
	if (result.fatal) throw new Error(result.fatal);
	return {
		files: result.files.map((f) => ({ name: f.name, data: Buffer.from(f.base64, "base64") })),
		output: result.output,
		error: result.error,
	};
}

/** Run a Python script in the sandbox. Throws PythonSandboxTimeout when it
 *  runs too long, AbortError when the signal fires. */
export async function runSandboxedPython(code: string, opts: SandboxedPythonOptions = {}): Promise<SandboxedPythonResult> {
	if (!pythonSandboxAvailable()) throw new Error("the Python sandbox files are missing from this install (node_modules/pyodide)");
	try {
		return await withBrowserPage((page) => runSandboxedPythonOnPage(page, code, opts));
	} catch (err) {
		if (err instanceof IsolatedPageCleanupError && err.cause instanceof PythonSandboxTimeout) throw err.cause;
		if (err instanceof IsolatedPageCleanupError && (err.cause as Error | undefined)?.name === "AbortError") throw err.cause;
		throw err;
	}
}
