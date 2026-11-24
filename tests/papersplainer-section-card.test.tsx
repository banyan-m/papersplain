/** papersplainer: the section card (reading layout A, with C for big figures). */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { isSectionCardDetails, MAX_POINT_WORDS, normalizeSectionCard, type SectionCardDetails } from "../src/core/section-card.ts";
import { forgetChatPaper, paperCacheDir, paperKeyForFile } from "../src/agent/subagents/paper-cache-store.ts";
import { paperConverterKeys } from "../src/agent/subagents/paper-document.ts";
import { createPaperTextTool } from "../src/agent/tools/paper-text.ts";
import { createSectionTool } from "../src/agent/tools/section-card.ts";
import { chatStore } from "../src/store/chats.ts";
import { SectionCardView } from "../components/artifacts/section-card.tsx";

const PDF = path.resolve("tests/fixtures/synthetic-paper.pdf");
const chats: string[] = [];
const savedKey = paperConverterKeys.mistral;
after(async () => {
	fs.rmSync(paperCacheDir(await paperKeyForFile(PDF)), { recursive: true, force: true });
	for (const id of chats) { forgetChatPaper(id); chatStore.deleteChat(id); }
	paperConverterKeys.mistral = savedKey;
});

const base = { title: " How it works ", points: [{ label: "The input", text: "Reads." }, { label: "The model", text: "A fit." }], takeaway: "Counts come from the fit." };

describe("normalizeSectionCard", () => {
	it("trims, gives each point its own colour, and keeps a chosen colour", () => {
		const card = normalizeSectionCard({ ...base, points: [...base.points, { label: "The catch", text: "No controls.", tone: "amber" }] });
		assert.equal(card.title, "How it works");
		assert.deepEqual(card.points.map((p) => p.tone), ["blue", "green", "amber"]);
		assert.equal(card.layout, "stack");
		assert.ok(isSectionCardDetails(card));
	});

	it("the side layout needs a figure", () => {
		assert.equal(normalizeSectionCard({ ...base, layout: "side" }).layout, "stack");
		assert.equal(normalizeSectionCard({ ...base, layout: "side", figure: 2 }).layout, "side");
	});

	it("refuses walls of text with a message that says what to do", () => {
		const long = Array.from({ length: MAX_POINT_WORDS + 1 }, () => "word").join(" ");
		assert.throws(() => normalizeSectionCard({ ...base, points: [{ label: "Long", text: long }] }), /has 71 words; the limit is 70\. Cut it, or split the section\./);
		assert.throws(() => normalizeSectionCard({ ...base, takeaway: long }), /the takeaway has 71 words/);
		assert.throws(() => normalizeSectionCard({ ...base, points: [{ label: "a label that runs far too long", text: "x" }] }), /two or three words/);
		assert.throws(() => normalizeSectionCard({ ...base, points: Array.from({ length: 6 }, (_, i) => ({ label: `P${i}`, text: "x" })) }), /at most 5 points/);
		assert.throws(() => normalizeSectionCard({ ...base, points: [{ label: " ", text: "x" }] }), /at least one point/);
	});
});

describe("the section tool", () => {
	it("attaches the paper's figure from the cache, and refuses a figure the paper does not have", async () => {
		paperConverterKeys.mistral = () => undefined;
		const chat = chatStore.createChat("Test: section card", "paper");
		chats.push(chat.id);
		await createPaperTextTool({ chatId: chat.id }).execute("p0", { path: PDF });
		const tool = createSectionTool({ chatId: chat.id, chatStore });
		const shown = await tool.execute("s1", { ...base, kicker: "Methods · p. 2", figure: 1, layout: "side" });
		const details = shown.details as SectionCardDetails;
		assert.equal(details.layout, "side");
		assert.equal(details.figure?.number, 1);
		assert.equal(details.figure?.cropped, true);
		assert.match(details.figure?.caption ?? "", /^Figure 1\. Overview of the method/);
		assert.ok(chatStore.getChat(chat.id)?.imageSnapshots?.[details.figure!.snapshotId], "the figure is saved with the chat");
		assert.match(shown.content.map((c) => ("text" in c ? c.text : "")).join(""), /Do not restate it/);
		const page = await tool.execute("s2", { ...base, figure: 2 });
		assert.match(page.content.map((c) => ("text" in c ? c.text : "")).join(""), /page 3, which carries Figure 2 \(the whole page is shown/);
		await assert.rejects(tool.execute("s3", { ...base, figure: 9 }), /there is no Figure 9; this paper's figures are: 1, 2, 3/);
		const plain = await tool.execute("s4", base);
		assert.equal((plain.details as SectionCardDetails).figure, undefined);
	});
});

describe("SectionCardView", () => {
	const figure = { number: 1, cropped: true, path: "figure-1.png", caption: "Figure 1. Overview.", mimeType: "image/png" as const, snapshotId: "abc", width: 800, height: 400 };
	it("renders title, kicker, coloured points and the takeaway; figure above the points when stacked", () => {
		const html = renderToStaticMarkup(<SectionCardView details={{ ...normalizeSectionCard({ ...base, kicker: "Methods · p. 2", figure: 1 }), figure }} />);
		assert.match(html, /data-testid="section-card" data-layout="stack"/);
		assert.ok(html.includes("Methods · p. 2") && html.includes("How it works"));
		assert.equal((html.match(/data-testid="section-point"/g) ?? []).length, 2);
		assert.match(html, /data-tone="blue"[^>]*>.*The input/s);
		assert.ok(html.indexOf('data-testid="section-figure"') < html.indexOf('data-testid="section-points"'));
		assert.ok(html.indexOf('data-testid="section-points"') < html.indexOf('data-testid="section-takeaway"'));
		assert.ok(html.includes("Figure 1. Overview."));
	});
	it("the side layout pins the figure beside the points; without a figure there is none", () => {
		const side = renderToStaticMarkup(<SectionCardView details={{ ...normalizeSectionCard({ ...base, figure: 1, layout: "side" }), figure }} />);
		assert.match(side, /data-layout="side"/);
		assert.match(side, /sticky/);
		const plain = renderToStaticMarkup(<SectionCardView details={normalizeSectionCard(base)} />);
		assert.ok(!plain.includes('data-testid="section-figure"'));
	});
});
