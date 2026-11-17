/**
 * papersplainer: serves a session's rendered files (Manim mp4, Molecular
 * Nodes png) from <data>/renders/<chatId>/. Session-owned files only: the
 * name must be a plain render file name, never a path. Supports byte
 * ranges so the video element can seek.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRenderFileName } from "@/src/core";
import { chatRendersDir, getChat } from "@/src/server";

const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".png": "image/png" };

export async function GET(req: Request, { params }: { params: Promise<{ id: string; file: string }> }): Promise<Response> {
	const { id, file } = await params;
	const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
	if (!isRenderFileName(file) || !/^[A-Za-z0-9_-]+$/.test(id) || !getChat(id)) return notFound();
	const full = path.join(chatRendersDir(id), file);
	let size: number;
	try {
		size = (await fs.stat(full)).size;
	} catch {
		return notFound();
	}
	const type = TYPES[path.extname(file)] ?? "application/octet-stream";
	const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
	if (range && (range[1] || range[2])) {
		const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start > end || start >= size) {
			return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
		}
		const handle = await fs.open(full, "r");
		try {
			const buffer = Buffer.alloc(end - start + 1);
			await handle.read(buffer, 0, buffer.length, start);
			return new Response(buffer, {
				status: 206,
				headers: { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(buffer.length) },
			});
		} finally {
			await handle.close();
		}
	}
	return new Response(await fs.readFile(full), { headers: { ...base, "Content-Length": String(size) } });
}
