/**
 * papersplainer: the paper converted once (core/paper-document.ts,
 * agent/subagents/paper-document.ts) and the `paper` tool that reads it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
	cropsForPage, decodeImage, describeDocument, findSection, mistralToMarkdown, paperOutline, pageMark, readSection,
	searchPaper, SECTION_PART_CHARS, splitSections,
} from "../src/core/paper-document.ts";
import { chatPaperKey, forgetChatPaper, paperCacheDir, paperKeyForFile, readManifest } from "../src/agent/subagents/paper-cache-store.ts";
import { ensurePaperDocument, mistralFetchOverride, paperConverterKeys, paperMarkdownPath } from "../src/agent/subagents/paper-document.ts";
import { createPaperTextTool } from "../src/agent/tools/paper-text.ts";
import { createPaperFigureTool } from "../src/agent/tools/paper-figure.ts";
import { chatStore } from "../src/store/chats.ts";

const PDF = path.resolve("tests/fixtures/synthetic-paper.pdf");
const KEY = await paperKeyForFile(PDF);
const chats: string[] = [];
const reset = () => fs.rmSync(paperCacheDir(KEY), { recursive: true, force: true });
const savedKey = paperConverterKeys.mistral;
after(() => {
	reset();
	for (const id of chats) { forgetChatPaper(id); chatStore.deleteChat(id); }
	paperConverterKeys.mistral = savedKey;
	mistralFetchOverride.current = undefined;
});
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text ?? "").join("");

describe("the paper's text: pure helpers", () => {
	const body = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i} of the text.`).join(" ");
	const md = [pageMark(1), "# Title", "Authors", "## Abstract", body(20), "## 1 Introduction", body(30), pageMark(2), "## 2 Methods", body(40), "Table 1. Datasets used.", "## Tiny", "x", "## 3 Results", body(20)].join("\n\n");

	it("splits at headings, records pages, and folds stray short sections away", () => {
		const sections = splitSections(md);
		assert.deepEqual(sections.map((s) => s.title), ["Title", "Abstract", "1 Introduction", "2 Methods", "3 Results"]);
		assert.deepEqual(sections.map((s) => s.page), [1, 1, 1, 2, 2]);
		assert.equal(sections[0]!.start, 0);
		assert.equal(sections.at(-1)!.end, md.length);
		for (let i = 1; i < sections.length; i++) assert.equal(sections[i]!.start, sections[i - 1]!.end, "sections tile the text");
	});

	it("a paper with no headings is split by page", () => {
		const flat = `${pageMark(1)}\n\n${body(20)}\n\n${pageMark(2)}\n\n${body(20)}`;
		assert.deepEqual(splitSections(flat).map((s) => s.title), ["Page 1", "Page 2"]);
	});

	it("finds a section by number or title, reads it in parts, and searches", () => {
		const doc = describeDocument(md, "pdf-text", 2, "now");
		assert.equal(findSection(doc, "3")?.title, "1 Introduction");
		assert.equal(findSection(doc, "methods")?.title, "2 Methods");
		assert.equal(findSection(doc, "nope"), undefined);
		const methods = readSection(md, findSection(doc, "methods")!);
		assert.ok(methods.text.startsWith("## 2 Methods"));
		assert.equal(methods.parts, 1);
		const long = `# Big\n\n${"word ".repeat(SECTION_PART_CHARS / 2)}`;
		const longDoc = describeDocument(long, "pdf-text", 1, "now");
		const second = readSection(long, longDoc.sections[0]!, 2);
		assert.deepEqual([second.part, second.parts], [2, 3]);
		const hits = searchPaper(md, doc, "datasets used");
		assert.equal(hits.length, 1);
		assert.deepEqual([hits[0]!.title, hits[0]!.page], ["2 Methods", 2]);
		assert.deepEqual(doc.tables, [{ number: 1, page: 2, caption: "Datasets used." }]);
	});

	it("the outline lists sections, figures and tables", () => {
		const doc = describeDocument(md, "mistral", 2, "now");
		const outline = paperOutline(doc, [{ number: 1, page: 2, caption: "Overview", cropped: true }, { number: 2, page: 2, caption: "Vector" }]);
		assert.match(outline, /converted with Mistral OCR/);
		assert.match(outline, /4\. 2 Methods \(p\. 2\)/);
		assert.match(outline, /Figure 1 \(p\. 2\): Overview/);
		assert.match(outline, /Figure 2 \(p\. 2\), shown as its whole page: Vector/);
		assert.match(outline, /Table 1 \(p\. 2\): Datasets used\./);
	});

	it("Mistral pages become one text, and each image is matched to the figure captioned beside it", () => {
		const out = mistralToMarkdown([
			{ index: 1, markdown: "## Results\n\n![img-1.jpeg](img-1.jpeg)\n\nFigure 2: Accuracy by depth.\n\nText.\n\n![img-2.jpeg](img-2.jpeg)\n\n![img-3.jpeg](img-3.jpeg)\n\nFig. 3. Two panels.", images: [
				{ id: "img-1.jpeg", top_left_x: 0, top_left_y: 0, bottom_right_x: 100, bottom_right_y: 100, image_base64: "x" },
				{ id: "img-2.jpeg", top_left_x: 0, top_left_y: 0, bottom_right_x: 10, bottom_right_y: 10 },
				{ id: "img-3.jpeg", top_left_x: 0, top_left_y: 0, bottom_right_x: 50, bottom_right_y: 50 },
			] },
			{ index: 0, markdown: "# Title\n\n![img-0.jpeg](img-0.jpeg)\n\nA logo, no caption.", images: [{ id: "img-0.jpeg" }] },
		]);
		assert.ok(out.markdown.indexOf(pageMark(1)) < out.markdown.indexOf(pageMark(2)), "pages in order");
		assert.deepEqual(out.images.map((i) => [i.id, i.page, i.figure]), [["img-0.jpeg", 1, undefined], ["img-1.jpeg", 2, 2], ["img-2.jpeg", 2, undefined], ["img-3.jpeg", 2, 3]]);
		assert.ok(out.markdown.includes("[Figure 2 appears here]"));
		assert.ok(out.markdown.includes("[an image appears here]"));
		assert.ok(!out.markdown.includes("![img"));
		assert.deepEqual(out.captions.map((c) => [c.number, c.page]), [[2, 2], [3, 2]]);
	});

	it("crops only when the page's images clearly belong to its figures", () => {
		const big = { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.5 };
		const low = { x0: 0.1, y0: 0.6, x1: 0.5, y1: 0.8 };
		const speck = { x0: 0, y0: 0, x1: 0.02, y1: 0.02 };
		assert.equal(cropsForPage([1], []).size, 0, "a vector figure: no crop");
		assert.equal(cropsForPage([1], [speck]).size, 0, "a logo-sized image is ignored");
		const one = cropsForPage([1], [big, speck]).get(1)!;
		assert.ok(one.x0 < 0.1 && one.x1 > 0.9 && one.y0 < 0.2 && one.y1 > 0.5, "padded");
		assert.deepEqual([...cropsForPage([4, 5], [low, big]).entries()].map(([n, b]) => [n, b.y0 < 0.3]), [[4, true], [5, false]], "top to bottom");
		assert.equal(cropsForPage([1, 2], [big]).size, 0, "two figures, one image: unclear, no crop");
		assert.equal(cropsForPage([1], [{ x0: 0, y0: 0, x1: 1, y1: 1 }]).size, 0, "a full-page scan is not a crop");
	});

	it("decodes PNG and JPEG payloads and rejects anything else", () => {
		const png = createCanvas(8, 8).toBuffer("image/png").toString("base64");
		assert.equal(decodeImage(`data:image/png;base64,${png}`)?.ext, "png");
		assert.equal(decodeImage(png)?.ext, "png");
		assert.equal(decodeImage(Buffer.from("not an image at all, just some text here").toString("base64")), null);
	});
});

describe("converting a paper once", () => {
	it("without a Mistral key: the PDF's own text, with the embedded-image figure cut out", async () => {
		reset();
		paperConverterKeys.mistral = () => undefined;
		const first = await ensurePaperDocument(PDF, KEY);
		assert.equal(first.document.converter, "pdf-text");
		assert.deepEqual(first.document.sections.map((s) => s.title).slice(1), ["Abstract", "1 Introduction", "2 Methods", "3 Results", "4 Discussion"]);
		assert.deepEqual(first.figures.map((f) => [f.number, f.page, f.cropped === true]), [[1, 2, true], [2, 3, false], [3, 3, false]]);
		assert.ok(fs.existsSync(paperMarkdownPath(KEY)));
		assert.equal(readManifest(KEY)?.document?.pages, 3);
		const stamp = fs.statSync(paperMarkdownPath(KEY)).mtimeMs;
		const again = await ensurePaperDocument(PDF, KEY);
		assert.equal(fs.statSync(paperMarkdownPath(KEY)).mtimeMs, stamp, "the second call reads the cache");
		assert.equal(again.markdown, first.markdown);
	});

	it("with a Mistral key: sends the PDF once and keeps the returned text and figure images", async () => {
		reset();
		paperConverterKeys.mistral = () => "test-key";
		const png = createCanvas(40, 30).toBuffer("image/png").toString("base64");
		const calls: { url: string; auth: string | null; body: { model: string; document: { type: string; document_url: string }; include_image_base64: boolean } }[] = [];
		mistralFetchOverride.current = (async (url: string, init: RequestInit) => {
			calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
			return Response.json({ pages: [
				{ index: 0, markdown: `# A paper\n\n## Abstract\n\n${"Abstract text. ".repeat(30)}`, images: [] },
				{ index: 1, markdown: `## Methods\n\n${"Method text. ".repeat(30)}\n\n![img-0.png](img-0.png)\n\nFigure 1: The pipeline.\n\nFigure 2: Not extracted as an image.`, images: [{ id: "img-0.png", top_left_x: 10, top_left_y: 10, bottom_right_x: 300, bottom_right_y: 200, image_base64: `data:image/png;base64,${png}` }] },
			] });
		}) as typeof fetch;
		const out = await ensurePaperDocument(PDF, KEY);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "https://api.mistral.ai/v1/ocr");
		assert.equal(calls[0]!.auth, "Bearer test-key");
		assert.equal(calls[0]!.body.model, "mistral-ocr-latest");
		assert.ok(calls[0]!.body.document.document_url.startsWith("data:application/pdf;base64,"));
		assert.equal(calls[0]!.body.include_image_base64, true);
		assert.equal(out.document.converter, "mistral");
		assert.deepEqual(out.figures.map((f) => [f.number, f.file, f.cropped === true]), [[1, "figure-1.png", true], [2, "figure-2.png", false]]);
		assert.ok(out.markdown.includes("[Figure 1 appears here]"));
		await ensurePaperDocument(PDF, KEY);
		assert.equal(calls.length, 1, "never sent twice");
	});

	it("a failed Mistral call falls back to the PDF's text and says so", async () => {
		reset();
		paperConverterKeys.mistral = () => "bad-key";
		mistralFetchOverride.current = (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
		const out = await ensurePaperDocument(PDF, KEY);
		assert.equal(out.document.converter, "pdf-text");
		assert.match(out.document.note ?? "", /Mistral OCR failed \(status 401/);
	});
});

describe("the paper tool", () => {
	it("converts on the first call with a path, then serves outline, sections and search to any linked conversation", async () => {
		reset();
		paperConverterKeys.mistral = () => undefined;
		const chat = chatStore.createChat("Test: paper tool", "paper");
		chats.push(chat.id);
		const tool = createPaperTextTool({ chatId: chat.id });
		await assert.rejects(tool.execute("c0", {}), /no paper is known for this conversation yet/);
		const outline = textOf(await tool.execute("c1", { path: PDF }));
		assert.match(outline, /Sections \(read one with `paper`/);
		assert.match(outline, /Figure 1 \(p\. 2\): Overview of the method/);
		assert.equal(chatPaperKey(chat.id), KEY, "the conversation is linked to the paper");
		const methods = textOf(await tool.execute("c2", { section: "Methods" }));
		assert.match(methods, /^Section 4: 2 Methods/);
		assert.match(methods, /The loss is L = sum of squared error/);
		assert.match(methods, /\[p\. 2\]|Table 1/);
		assert.match(textOf(await tool.execute("c3", { search: "heat map" })), /Section 5 "3 Results" \(p\. 3\)/);
		assert.match(textOf(await tool.execute("c4", { search: "zebrafish" })), /does not occur/);
		await assert.rejects(tool.execute("c5", { section: "99" }), /there is no section "99"; the sections are: 1\. /);
		await assert.rejects(tool.execute("c6", { path: path.resolve("tests/fixtures/sample-3page.pdf") }), /already has its paper/);

		const figure = createPaperFigureTool({ chatId: chat.id, chatStore });
		assert.match(textOf(await figure.execute("f1", { figure: 1 })), /Shown to the learner: the figure itself\. Figure 1 \(page 2\)/);
		assert.match(textOf(await figure.execute("f2", { figure: 2 })), /the whole of page 3/);
	});
});
