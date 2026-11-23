/**
 * papersplainer size trims: what the packaged app leaves out of its server
 * folder, and what the animation environment removes from the Python it
 * downloads. Both are pinned here so a later change cannot quietly put the
 * weight back, or remove something a render needs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { trimManagedPythons, trimPython } from "../src/agent/subagents/render-env.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

function tree(base: string, files: string[]): void {
	for (const file of files) {
		const full = path.join(base, ...file.split("/"));
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, "x");
	}
}

function listing(base: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(path.relative(base, full).split(path.sep).join("/"));
		}
	};
	walk(base);
	return out.sort();
}

function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-trim-"));
	return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe("packaged app contents", () => {
	it("leaves the repo's tests, docs and unpacked plugin kit out of the server folder, and nothing else", async () => {
		await withTemp(async (dir) => {
			const source = path.join(dir, "source"), destination = path.join(dir, "out");
			const kept = [
				"server.js",
				"src/agent/system-prompt.md",
				"public/plugin-authoring/learnharness-plugins.zip",
				"core-plugins/flashcards/tests/keep.js",
				"node_modules/next/docs/keep.md",
				"node_modules/some-package/tests/keep.js",
				".next/server/app/docs/page.js",
			];
			const dropped = ["tests/a.test.ts", "tests/fixtures/deep/b.bin", "docs/architecture.md", "docs/assets/shot.png", "plugin-authoring/SKILL.md", "plugin-authoring/docs/plugin-api/README.md"];
			tree(path.join(source, ".next", "standalone"), [...kept, ...dropped]);
			tree(source, ["docs/compaction-accounting.md"]);
			const yaml = require("js-yaml");
			const config = yaml.load(fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
			const { getFileMatchers, copyFiles } = require("app-builder-lib/out/fileMatcher.js");
			for (const platform of ["mac", "win", "linux"]) {
				const out = path.join(destination, platform);
				const matchers = getFileMatchers(config, "extraResources", out, {
					defaultSrc: source, customBuildOptions: { ...config[platform], extraResources: undefined }, macroExpander: (value: string) => value,
					globalOutDir: path.join(source, "dist"),
				});
				await copyFiles(matchers, null, false);
				assert.deepEqual(listing(path.join(out, "server", "standalone")), [...kept].sort(), platform);
				// The licence text electron-builder copies from docs/ is a separate entry and stays.
				assert.ok(fs.existsSync(path.join(out, "licenses", "pi-compaction.md")), platform);
			}
		});
	});
});

describe("downloaded Python trim", () => {
	const unixKept = [
		"bin/python3.11",
		"lib/libpython3.11.so.1.0",
		"lib/python3.11/os.py",
		"lib/python3.11/unittest/__init__.py",
		"lib/python3.11/threading.py",
		"lib/python3.11/distutils/core.py",
		"lib/python3.11/config-3.11-x86_64-linux-gnu/Makefile",
		"lib/python3.11/lib-dynload/_ssl.cpython-311-x86_64-linux-gnu.so",
		"lib/python3.11/lib-dynload/_ctypes.cpython-311-x86_64-linux-gnu.so",
	];
	const unixDropped = [
		"lib/python3.11/tkinter/__init__.py",
		"lib/python3.11/idlelib/idle.py",
		"lib/python3.11/turtledemo/clock.py",
		"lib/python3.11/turtle.py",
		"lib/python3.11/test/test_os.py",
		"lib/python3.11/ensurepip/_bundled/pip.whl",
		"lib/python3.11/lib2to3/main.py",
		"lib/python3.11/lib-dynload/_tkinter.cpython-311-x86_64-linux-gnu.so",
		"lib/python3.11/lib-dynload/_testcapi.cpython-311-x86_64-linux-gnu.so",
		"lib/python3.11/lib-dynload/_ctypes_test.cpython-311-x86_64-linux-gnu.so",
		"lib/python3.11/site-packages/pip/__init__.py",
		"lib/python3.11/site-packages/setuptools/__init__.py",
		"lib/libtcl9.0.so",
		"lib/libtcl9tk9.0.so",
		"lib/libtk8.6.dylib",
		"lib/tcl9.0/init.tcl",
		"lib/tk9.0/tk.tcl",
		"lib/itcl4.3.5/itcl.tcl",
		"lib/thread3.0.4/pkgIndex.tcl",
		"lib/pkgconfig/python3.pc",
		"include/python3.11/Python.h",
		"share/man/man1/python3.1",
		"share/terminfo/x/xterm",
	];

	it("removes Tk, the tests, the pip bootstrap and development files from a macOS or Linux install", async () => {
		await withTemp(async (dir) => {
			tree(dir, [...unixKept, ...unixDropped]);
			await trimPython(dir, { natives: true });
			assert.deepEqual(listing(dir), [...unixKept].sort());
		});
	});

	it("removes the same from a Windows install", async () => {
		await withTemp(async (dir) => {
			const kept = ["python.exe", "python311.dll", "DLLs/_ssl.pyd", "DLLs/_ctypes.pyd", "DLLs/libcrypto-3.dll", "Lib/os.py", "Lib/threading.py", "Lib/unittest/__init__.py"];
			const dropped = [
				"DLLs/_tkinter.pyd", "DLLs/tcl86t.dll", "DLLs/tk86t.dll", "DLLs/_testcapi.pyd", "DLLs/_ctypes_test.pyd",
				"Lib/tkinter/__init__.py", "Lib/idlelib/idle.py", "Lib/test/test_os.py", "Lib/ensurepip/__init__.py", "Lib/lib2to3/main.py", "Lib/turtledemo/clock.py",
				"Lib/site-packages/pip/__init__.py", "tcl/tcl8.6/init.tcl", "include/Python.h", "libs/python311.lib",
			];
			tree(dir, [...kept, ...dropped]);
			await trimPython(dir, { natives: true });
			assert.deepEqual(listing(dir), [...kept].sort());
		});
	});

	it("in a full prebuilt base, removes only the standard-library folders and keeps its packages and libraries", async () => {
		await withTemp(async (dir) => {
			const kept = unixKept.concat(unixDropped.filter((file) => !/python3\.11\/(tkinter|idlelib|turtledemo|turtle\.py|test|ensurepip|lib2to3)(\/|$)/.test(file)));
			tree(dir, [...unixKept, ...unixDropped]);
			await trimPython(dir, { natives: false });
			assert.deepEqual(listing(dir), [...kept].sort());
		});
	});

	it("trims each Python the app downloaded and leaves a folder that is not a Python install alone", async () => {
		await withTemp(async (dir) => {
			tree(path.join(dir, "cpython-3.11.15-linux-x86_64-gnu"), ["lib/python3.11/os.py", "lib/python3.11/tkinter/__init__.py", "include/Python.h"]);
			tree(path.join(dir, "cpython-3.11.15-odd"), ["include/keep.h", "tcl/keep.tcl"]);
			tree(path.join(dir, ".temp"), ["include/keep.h"]);
			await trimManagedPythons(dir);
			assert.deepEqual(listing(dir), [".temp/include/keep.h", "cpython-3.11.15-linux-x86_64-gnu/lib/python3.11/os.py", "cpython-3.11.15-odd/include/keep.h", "cpython-3.11.15-odd/tcl/keep.tcl"]);
			await trimManagedPythons(path.join(dir, "missing"));
		});
	});
});
