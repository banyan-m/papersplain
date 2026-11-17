"use client";

/**
 * papersplainer: first-launch setup of the Manim environment. Mounted once
 * in the root layout. On load it asks the server whether the environment
 * is ready; if not, it starts the install and shows a small card with the
 * current step until it finishes. A failure stays visible with a Retry.
 * Nothing renders once the environment is ready.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";

export interface RenderEnvView {
	manim: { ready: boolean; installing: boolean };
	errors?: { manim?: string };
	activity?: { manim?: string };
}

export type RenderEnvBanner =
	| { kind: "hidden" }
	| { kind: "installing"; step: string }
	| { kind: "failed"; reason: string };

/** What the card shows for a status. Pure, exported for tests. */
export function renderEnvBanner(view: RenderEnvView | null): RenderEnvBanner {
	if (!view || view.manim.ready) return { kind: "hidden" };
	if (view.manim.installing) return { kind: "installing", step: view.activity?.manim ?? "starting" };
	if (view.errors?.manim) return { kind: "failed", reason: view.errors.manim };
	return { kind: "hidden" };
}

const POLL_MS = 3000;

export default function RenderEnvSetup() {
	const [view, setView] = useState<RenderEnvView | null>(null);
	const [dismissed, setDismissed] = useState(false);
	const started = useRef(false);

	const refresh = useCallback(async (): Promise<RenderEnvView | null> => {
		try {
			const res = await fetch("/api/render-env", { cache: "no-store" });
			if (!res.ok) return null;
			const next = (await res.json()) as RenderEnvView;
			setView(next);
			return next;
		} catch {
			return null;
		}
	}, []);

	const install = useCallback(async () => {
		setDismissed(false);
		await fetch("/api/render-env", { method: "POST" }).catch(() => {});
		await refresh();
	}, [refresh]);

	// First load: start the install once if nothing is ready, running, or failed.
	useEffect(() => {
		void refresh().then((status) => {
			if (!status || started.current) return;
			if (!status.manim.ready && !status.manim.installing && !status.errors?.manim) {
				started.current = true;
				void install();
			}
		});
	}, [refresh, install]);

	// Poll only while an install is running.
	const installing = view?.manim.installing === true;
	useEffect(() => {
		if (!installing) return;
		const timer = setInterval(() => void refresh(), POLL_MS);
		return () => clearInterval(timer);
	}, [installing, refresh]);

	const banner = renderEnvBanner(view);
	if (banner.kind === "hidden" || dismissed) return null;
	return (
		<div
			data-testid="render-env-banner"
			data-state={banner.kind}
			role="status"
			className="fixed bottom-4 left-4 z-50 flex max-w-md items-start gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
		>
			<div className="min-w-0 text-sm">
				{banner.kind === "installing" ? (
					<>
						<div className="font-medium">Setting up animations (one time)</div>
						<div className="truncate text-muted-foreground">{banner.step}</div>
					</>
				) : (
					<>
						<div className="font-medium">Animation setup failed</div>
						<div className="break-words text-muted-foreground">{banner.reason}</div>
					</>
				)}
			</div>
			{banner.kind === "failed" && (
				<button
					type="button"
					onClick={() => void install()}
					className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
				>
					Retry
				</button>
			)}
			<button
				type="button"
				aria-label="Hide animation setup status"
				onClick={() => setDismissed(true)}
				className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<XIcon className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}
