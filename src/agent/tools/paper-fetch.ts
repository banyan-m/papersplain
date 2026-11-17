import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PATHS } from "../../../config.ts";
import { serverExecute } from "../tool-execute.ts";
import { isWithin, realSourcePath } from "./file-access.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { safeFetch } from "./safe-fetch.ts";

/**
 * papersplainer: fetch_paper. The learner may give a paper as a link
 * instead of a file. This tool downloads the PDF into the app's own
 * papers folder and returns the local path, which the pdf job then reads
 * like any other PDF.
 *
 * Contract (the web tools' law): never throw into the agent loop; every
 * failure is a clear error string the guide can relay.
 */

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 90_000;
const MAX_PAPER_BYTES = 50 * 1024 * 1024;

/** Rewrite the common preprint landing-page links to their PDF. Anything
 *  else is returned unchanged (it may already be a PDF link). Pure. */
export function paperPdfUrl(link: string): string {
	let url: URL;
	try {
		url = new URL(link.trim());
	} catch {
		return link.trim();
	}
	const host = url.hostname.replace(/^www\./, "");
	if (host === "arxiv.org" || host === "export.arxiv.org") {
		const m = /^\/(abs|pdf)\/(.+?)(\.pdf)?$/.exec(url.pathname);
		if (m) return `https://arxiv.org/pdf/${m[2]}`;
	}
	if (host === "biorxiv.org" || host === "medrxiv.org") {
		const m = /^(\/content\/(?:early\/\d{4}\/\d{2}\/\d{2}\/)?10\.\d{4,}\/[^/]+?)(?:\.full(?:\.pdf)?|\.abstract|\.full-text)?(?:\+html)?$/.exec(url.pathname);
		if (m) return `https://www.${host}${m[1]}.full.pdf`;
	}
	return url.toString();
}

function paperFileName(url: string): string {
	let stem = "paper";
	try {
		const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "paper";
		stem = last.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-60) || "paper";
	} catch { /* keep the default stem */ }
	return `${stem}-${Math.random().toString(36).slice(2, 8)}.pdf`;
}

/** Download a paper PDF. Returns the saved path, or throws with a reason. */
export async function downloadPaper(link: string, signal?: AbortSignal): Promise<{ path: string; url: string; bytes: number }> {
	const url = paperPdfUrl(link);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`"${link}" is not a URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only http(s) links are supported");
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const resp = await safeFetch(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,application/octet-stream,*/*" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`.trim());
	if (Number(resp.headers.get("content-length") ?? 0) > MAX_PAPER_BYTES) throw new Error("the file is larger than 50 MB");
	const bytes = new Uint8Array(await resp.arrayBuffer());
	if (bytes.length > MAX_PAPER_BYTES) throw new Error("the file is larger than 50 MB");
	// "%PDF" within the first kilobyte (a few servers prepend whitespace).
	const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
	if (!head.includes("%PDF")) {
		throw new Error(
			"the link did not return a PDF (it may be a landing page, or the paper may need a login). " +
			"Ask the learner to download the PDF and give its file path instead",
		);
	}
	await fs.mkdir(PATHS.papers, { recursive: true });
	const filePath = path.join(PATHS.papers, paperFileName(url));
	await fs.writeFile(filePath, bytes);
	return { path: filePath, url, bytes: bytes.length };
}

const fetchPaperInput = Type.Object({
	url: Type.String({ description: "The paper's link: a direct PDF link, or an arXiv, bioRxiv or medRxiv page." }),
});

export const fetchPaperTool: AgentTool<typeof fetchPaperInput> = {
	name: "fetch_paper",
	label: "fetch_paper",
	description:
		"Download a paper's PDF from a link the learner gave (direct PDF links, arXiv, bioRxiv, medRxiv). " +
		"Returns the local file path; then dispatch the pdf tool on that path to read it. " +
		"Not for files already on the learner's computer: use their path directly.",
	parameters: fetchPaperInput,
	execute: serverExecute("fetch_paper", fetchPaperInput, async ({ url }, { signal }) => {
		try {
			const saved = await downloadPaper(url, signal);
			return `Saved ${(saved.bytes / 1024 / 1024).toFixed(1)} MB from ${saved.url} to ${saved.path}\nRead it with the pdf tool, using exactly that path.`;
		} catch (err) {
			if (signal?.aborted) throw err;
			return `fetch_paper failed for ${url}: ${err instanceof Error ? err.message : String(err)}.`;
		}
	}),
};

/** A PDF path for the reader: the app's own downloaded papers are always
 *  readable (they are not learner files, so the file-access folder list
 *  does not apply); everything else goes through the normal boundary. */
export function resolvePaperOrSourcePath(p: string): string {
	if (path.isAbsolute(p)) {
		try {
			const real = realSourcePath(p);
			const papers = realSourcePath(PATHS.papers);
			if (isWithin(real, papers) && real !== papers && fsSync.statSync(real).isFile()) return real;
		} catch { /* fall through to the normal boundary */ }
	}
	return resolveSourcePath(p);
}
