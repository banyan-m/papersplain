import type { ArtifactPartProps, OutlineDetails } from "@/src/core";

/**
 * papersplainer: the walkthrough's `outline` call in the transcript — one
 * quiet line marking where a section starts ("Section 2 of 7 · The
 * diffusion module"). Renders nothing until the call has its result, and
 * nothing for a refused call.
 */
export function OutlineCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	const details = part.output as Partial<OutlineDetails> | null | undefined;
	if (!details || !Array.isArray(details.sections) || typeof details.current !== "number") return null;
	const title = details.sections[details.current - 1];
	if (typeof title !== "string") return null;
	return (
		<div data-testid="outline-mark" className="my-3 flex items-center gap-3 text-xs text-muted-foreground">
			<span className="shrink-0">Section {details.current} of {details.sections.length}</span>
			<span className="min-w-0 truncate text-foreground">{title}</span>
			<span className="h-px flex-1 bg-border/60" aria-hidden />
		</div>
	);
}
