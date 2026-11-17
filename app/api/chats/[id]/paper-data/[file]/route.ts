/**
 * papersplainer: downloads one file of the toy dataset in a session's
 * paper cache. The name must be a plain cache file name; the folder comes
 * from the session's own paper link, never from the request.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isCacheFileName } from "@/src/core";
import { chatCacheKey, getChat, toyDir } from "@/src/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }): Promise<Response> {
	const { id, file } = await params;
	const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
	if (!isCacheFileName(file) || !/^[A-Za-z0-9_-]+$/.test(id) || !getChat(id)) return notFound();
	let bytes: Buffer;
	try {
		bytes = await fs.readFile(path.join(toyDir(chatCacheKey(id)), file));
	} catch {
		return notFound();
	}
	return new Response(new Uint8Array(bytes), {
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": `attachment; filename="${file}"`,
			"Content-Length": String(bytes.length),
			"Cache-Control": "private, no-store",
		},
	});
}
