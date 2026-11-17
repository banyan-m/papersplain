"use client";

import { useContext } from "react";
import { DownloadIcon } from "lucide-react";
import { ChatActionsContext } from "@/components/chat";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { isRenderFileName, MOLECULE_COLORS, MOLECULE_STYLES, type ArtifactPartProps, type ManimResult, type MoleculeDetails } from "@/src/core";
import { MoleculeViewer } from "@/components/artifacts/molecule-viewer";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";

/**
 * papersplainer: the animation and structure cards. A Manim clip is a
 * background job (shared DispatchCard, then the video). A structure is an
 * instant tool result shown in an interactive 3D viewer. Both load their
 * file from the session's renders route. Document material, like figures:
 * no card chrome.
 */

export function ManimCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="manim" />;
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

/** True when a tool part's output is a usable molecule record. */
export function isMoleculeDetails(value: unknown): value is MoleculeDetails {
	const d = value as Partial<MoleculeDetails> | null;
	return typeof d === "object" && d !== null && typeof d.title === "string" && typeof d.file === "string" && isRenderFileName(d.file) &&
		(d.format === "pdb" || d.format === "cif") && (MOLECULE_STYLES as readonly unknown[]).includes(d.style) &&
		(MOLECULE_COLORS as readonly unknown[]).includes(d.color);
}

/** The molecule tool's card: the interactive structure view. The tool is
 *  instant, so there is no dispatch state; until the result lands the
 *  ordinary tool-call line shows. */
export function MoleculeCard({ part }: ArtifactPartProps) {
	const chatId = useContext(ChatActionsContext)?.chatId;
	if (part.state !== "output-available") return <ToolCallCard part={part} />;
	const details = part.output;
	const url = isMoleculeDetails(details) ? renderFileUrl(chatId, details.file) : null;
	if (!isMoleculeDetails(details) || !url) {
		return <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Structure shown, but it could not be displayed.</div>;
	}
	const chains = `${details.chains.length} chain${details.chains.length === 1 ? "" : "s"}`;
	return (
		<figure className="my-4 w-full" data-testid="molecule-card">
			<MoleculeViewer url={url} format={details.format} style={details.style} color={details.color} label={details.title} />
			<Caption
				label="Structure"
				title={`${details.title} · ${details.source} · ${details.residues} residues, ${chains} · drag to rotate, scroll to zoom`}
				href={url}
				download={details.file}
			/>
		</figure>
	);
}
