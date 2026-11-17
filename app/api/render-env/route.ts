/**
 * papersplainer: the Manim environment's status and setup.
 *   GET  → whether the environment is ready, installing, or failed.
 *   POST → starts the install in the background and returns at once;
 *          poll GET for progress. A no-op when already ready or installing.
 */
import { ensureRenderEnv, renderEnvStatus } from "@/src/server";

export const dynamic = "force-dynamic";

const lastError: { manim?: string } = {};
const lastActivity: { manim?: string } = {};

export async function GET(): Promise<Response> {
	return Response.json({ ...renderEnvStatus(), errors: lastError, activity: lastActivity });
}

export async function POST(req: Request): Promise<Response> {
	void req;
	const kind = "manim" as const;
	const status = renderEnvStatus();
	if (status.manim.ready || status.manim.installing) return Response.json({ started: false }, { status: 200 });
	delete lastError[kind];
	lastActivity[kind] = "starting";
	void ensureRenderEnv(kind, (line) => { lastActivity[kind] = line; })
		.then(() => { delete lastActivity[kind]; })
		.catch((err: unknown) => {
			delete lastActivity[kind];
			lastError[kind] = err instanceof Error ? err.message : String(err);
		});
	return Response.json({ started: true }, { status: 202 });
}
