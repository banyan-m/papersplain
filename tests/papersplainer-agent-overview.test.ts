/** papersplainer: the read-only "How the agents work" view. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

process.env.LH_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "lh-overview-"));
const { agentOverview, partTitle } = await import("../src/server/agent-overview.ts");

describe("agentOverview", () => {
	it("lists the six entries in order, each with a summary and its text", () => {
		const entries = agentOverview();
		assert.deepEqual(entries.map((e) => e.id), ["walkthrough", "chat", "prober", "teacher", "practice", "shared"]);
		for (const entry of entries) {
			assert.ok(entry.summary.length > 20, entry.id);
			assert.ok(entry.parts.length > 0, `${entry.id} has text`);
			for (const part of entry.parts) assert.ok(part.text.trim().length > 0, `${entry.id}/${part.title}`);
		}
	});

	it("the two guides share their files and differ in the mode paragraph", () => {
		const [walkthrough, chat] = agentOverview();
		assert.deepEqual(walkthrough!.parts.slice(0, -1), chat!.parts.slice(0, -1));
		assert.match(walkthrough!.parts.at(-1)!.text, /walkthrough/);
		assert.match(chat!.parts.at(-1)!.text, /free chat/);
	});

	it("shared files appear once, under Shared rules only", () => {
		const entries = agentOverview();
		const shared = entries.at(-1)!;
		assert.ok(shared.parts.some((p) => p.path === "shared/10-voice.md"));
		const sharedPaths = new Set(shared.parts.map((p) => p.path));
		for (const entry of entries.slice(0, -1)) assert.ok(entry.parts.every((p) => !sharedPaths.has(p.path)), entry.id);
		assert.equal(new Set(shared.parts.map((p) => p.path)).size, shared.parts.length);
	});

	it("names a part by its first heading, else by its file name", () => {
		assert.equal(partTitle("guide/20-explaining.md", "intro\n## Explaining a section\ntext"), "Explaining a section");
		assert.equal(partTitle("shared/40-formatting.md", "no heading here"), "formatting");
	});
});
