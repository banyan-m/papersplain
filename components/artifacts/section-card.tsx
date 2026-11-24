"use client";

import type { CSSProperties } from "react";
import { isSectionCardDetails, type ArtifactPartProps, type SectionCardDetails, type SectionTone } from "@/src/core";
import { HostMarkdown } from "@/components/host-markdown";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { useImageSnapshot } from "./use-image-snapshot";

/**
 * papersplainer: one section of a paper as a reading spread (the guide's
 * `section` call). Layout "stack": the paper's figure on top, the points
 * below. Layout "side": the figure stays pinned on the left while the
 * points scroll past it on the right (wide windows; it stacks when narrow).
 * Each point has its own colour; the takeaway closes the card.
 */

/** Readable on both the dark and the light theme. */
const TONE: Record<SectionTone, string> = {
	blue: "#4f8fe8",
	green: "#2fa86f",
	amber: "#d4962a",
	rose: "#e0607f",
	violet: "#9278ea",
};

export function SectionCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return <ToolCallCard part={part} />;
	if (!isSectionCardDetails(part.output)) return <ToolCallCard part={part} />;
	return <SectionCardView details={part.output} />;
}

function Figure({ figure, pinned }: { figure: NonNullable<SectionCardDetails["figure"]>; pinned: boolean }) {
	const { image, failed } = useImageSnapshot(figure.snapshotId);
	return (
		<figure data-testid="section-figure" className={pinned ? "@3xl:sticky @3xl:top-4 @3xl:self-start" : undefined}>
			<div className="overflow-hidden rounded-lg border border-border bg-white">
				{image ? (
					/* An in-memory image from the record; no Next image optimization. */
					/* eslint-disable-next-line @next/next/no-img-element */
					<img
						src={`data:${image.mimeType};base64,${image.data}`}
						alt={figure.caption ?? `Figure ${figure.number}`}
						width={image.width}
						height={image.height}
						className={`mx-auto block h-auto w-auto max-w-full ${pinned ? "max-h-[70vh]" : "max-h-[55vh]"}`}
						draggable={false}
					/>
				) : (
					<div role="status" className="px-4 py-10 text-center text-sm text-neutral-500">{failed ? "The figure could not be loaded." : "Loading the figure…"}</div>
				)}
			</div>
			{figure.caption && <figcaption className="mt-2 text-xs leading-relaxed text-muted-foreground">{figure.caption}</figcaption>}
		</figure>
	);
}

export function SectionCardView({ details }: { details: SectionCardDetails }) {
	const side = details.layout === "side" && Boolean(details.figure);
	const points = (
		<ol data-testid="section-points" className="flex flex-col gap-3">
			{details.points.map((point, i) => (
				<li
					key={i}
					data-testid="section-point"
					data-tone={point.tone}
					style={{ "--tone": TONE[point.tone], borderLeftColor: TONE[point.tone] } as CSSProperties}
					className="rounded-r-lg border-l-[3px] bg-[color-mix(in_srgb,var(--tone)_9%,transparent)] py-2.5 pl-4 pr-3"
				>
					<p className="mb-0.5 text-xs font-semibold text-[var(--tone)]">{point.label}</p>
					<div className="text-[15px] leading-relaxed text-foreground [&_p]:my-0 [&_p+p]:mt-2">
						<HostMarkdown text={point.text} />
					</div>
				</li>
			))}
		</ol>
	);
	return (
		<section data-testid="section-card" data-layout={side ? "side" : "stack"} className="@container my-5 rounded-xl border border-border bg-card p-5">
			<header className="mb-4">
				{details.kicker && <p className="mb-1 text-xs font-medium text-muted-foreground">{details.kicker}</p>}
				<h3 className="font-title text-xl font-semibold leading-snug text-foreground">{details.title}</h3>
			</header>
			{side ? (
				<div className="grid gap-5 @3xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
					<Figure figure={details.figure!} pinned />
					{points}
				</div>
			) : (
				<div className="flex flex-col gap-5">
					{details.figure && <Figure figure={details.figure} pinned={false} />}
					{points}
				</div>
			)}
			<div data-testid="section-takeaway" className="mt-5 rounded-lg bg-foreground/[0.06] px-4 py-3">
				<p className="mb-0.5 text-xs font-semibold text-muted-foreground">Takeaway</p>
				<div className="text-[15px] font-medium leading-relaxed text-foreground [&_p]:my-0">
					<HostMarkdown text={details.takeaway} />
				</div>
			</div>
		</section>
	);
}
