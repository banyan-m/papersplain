"use client";

import { useContext } from "react";
import { DownloadIcon } from "lucide-react";
import { ChatActionsContext } from "@/components/chat";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { isRenderFileName, type ArtifactPartProps, type ManimResult, type MoleculeResult } from "@/src/core";

/**
 * papersplainer: the render-job cards. The dispatch side is the shared
 * DispatchCard; the delivered side is the rendered file itself (a Manim
 * clip or a Molecular Nodes image), streamed from the session's renders
 * route. Document material, like figures: no card chrome.
 */

export function ManimCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="manim" />;
}

export function MoleculeCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="molecule" />;
}

/** The URL of a session render, or null when the file name is not a render name. */
export function renderFileUrl(chatId: string | undefined, file: unknown): string | null {
	if (!chatId || typeof file !== "string" || !isRenderFileName(file)) return null;
	return `/api/chats/${encodeURIComponent(chatId)}/renders/${encodeURIComponent(file)}`;
}

function FailedCard({ label, testId, notes, fallback }: { label: string; testId: string; notes?: string; fallback: string }) {
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid={testId}>
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label}
				<span className="rounded bg-error/15 px-1.5 py-0.5 text-error">failed</span>
			</div>
			<p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{notes ?? fallback}</p>
		</div>
	);
}

function Caption({ label, title, href, download }: { label: string; title: string; href: string; download: string }) {
	return (
		<figcaption className="mt-2 flex items-start justify-between gap-2">
			<div className="flex min-w-0 items-baseline gap-2">
				<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
				<span className="text-sm text-muted-foreground">{title}</span>
			</div>
			<a
				href={href}
				download={download}
				aria-label={`Download ${label.toLowerCase()}`}
				title={`Download ${label.toLowerCase()}`}
				className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<DownloadIcon className="size-3.5" />
			</a>
		</figcaption>
	);
}

export function ManimOutputCard({ output }: { output: unknown }) {
	const result = output as ManimResult | undefined;
	const chatId = useContext(ChatActionsContext)?.chatId;
	if (!result || typeof result.file !== "string") {
		return <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Animation completed, but the result could not be displayed.</div>;
	}
	if (result.file.length === 0) {
		return <FailedCard label="Animation" testId="manim-card-failed" notes={result.notes} fallback="The animation could not be rendered." />;
	}
	const url = renderFileUrl(chatId, result.file);
	if (!url) return <div className="my-4 text-sm text-muted-foreground" role="status">Animation file unavailable.</div>;
	return (
		<figure className="my-4 w-full" data-testid="manim-card">
			<video
				src={url}
				controls
				loop
				muted
				playsInline
				preload="metadata"
				className="block w-full overflow-hidden rounded-lg bg-black"
				data-testid="manim-video"
			/>
			<Caption label="Animation" title={result.title} href={url} download={result.file} />
		</figure>
	);
}

export function MoleculeOutputCard({ output }: { output: unknown }) {
	const result = output as MoleculeResult | undefined;
	const chatId = useContext(ChatActionsContext)?.chatId;
	if (!result || typeof result.file !== "string") {
		return <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Structure render completed, but the result could not be displayed.</div>;
	}
	if (result.file.length === 0) {
		return <FailedCard label="Structure" testId="molecule-card-failed" notes={result.notes} fallback="The structure could not be rendered." />;
	}
	const url = renderFileUrl(chatId, result.file);
	if (!url) return <div className="my-4 text-sm text-muted-foreground" role="status">Structure image unavailable.</div>;
	return (
		<figure className="my-4 w-full" data-testid="molecule-card">
			{/* A session-owned render served by the app; no Next image optimization. */}
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={url} alt={result.title} className="block h-auto w-full rounded-lg" draggable={false} data-testid="molecule-image" />
			<Caption label="Structure" title={`${result.title}${result.source ? ` · ${result.source}` : ""}`} href={url} download={result.file} />
		</figure>
	);
}
