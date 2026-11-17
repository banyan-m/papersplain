/**
 * papersplainer: the render environment's status and setup.
 *   GET  → which of the Manim / Molecular Nodes environments are ready.
 *   POST → { kind: "manim" | "molecule" } starts that install in the
 *          background and returns at once; poll GET for progress.
 */
import { ensureRenderEnv, renderEnvStatus } from "@/src/server";

export const dynamic = "force-dynamic";

const lastError: Partial<Record<"manim" | "molecule", string>> = {};
const lastActivity: Partial<Record<"manim" | "molecule", string>> = {};

export async function GET(): Promise<Response> {
	return Response.json({ ...renderEnvStatus(), errors: lastError, activity: lastActivity });
}

export async function POST(req: Request): Promise<Response> {
	const body = (await req.json().catch(() => null)) as { kind?: unknown } | null;
	const kind = body?.kind;
	if (kind !== "manim" && kind !== "molecule") {
		return Response.json({ error: 'kind must be "manim" or "molecule"' }, { status: 400 });
	}
	delete lastError[kind];
	void ensureRenderEnv(kind, (line) => { lastActivity[kind] = line; })
		.then(() => { delete lastActivity[kind]; })
		.catch((err: unknown) => {
			delete lastActivity[kind];
			lastError[kind] = err instanceof Error ? err.message : String(err);
		});
	return Response.json({ started: true }, { status: 202 });
}
