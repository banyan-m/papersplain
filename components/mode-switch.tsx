"use client";

/**
 * The mode switch (papersplainer, owner 2026-11-19): the three conversations
 * of one paper or topic as a single joined control, centered over the
 * conversation. Each segment is a link to the same subject in another mode;
 * a mode with no conversation yet opens its empty first screen.
 *
 * Also the shared description of "the subject this view belongs to" that the
 * conversation view and the draft view both receive.
 */

import Link from "next/link";
import { ChartNoAxesColumnIcon } from "lucide-react";
import { SUBJECT_MODES, subjectHref, type SubjectKind, type SubjectMode } from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";

export interface SubjectView {
	id: string;
	kind: SubjectKind;
	title: string;
	/** The mode on screen. */
	mode: SubjectMode;
	/** Modes that already have a conversation. */
	modes: readonly SubjectMode[];
}

export const MODE_LABEL: Record<SubjectMode, string> = { walkthrough: "Walkthrough", chat: "Chat", practice: "Practice" };

export function ModeSwitch({ subject, className }: { subject: SubjectView; className?: string }) {
	return (
		<nav
			aria-label="Mode"
			data-testid="mode-switch"
			// One track, three segments, no gaps: the mode on screen is the
			// filled one (the same fill the sidebar's selected row uses).
			className={cn("lh-no-drag inline-flex items-center overflow-hidden rounded-lg border border-border/70 bg-background p-0.5", className)}
		>
			{SUBJECT_MODES.map((mode) => {
				const current = mode === subject.mode;
				return (
					<Link
						key={mode}
						href={subjectHref(subject.id, mode)}
						data-testid={`mode-${mode}`}
						aria-current={current ? "page" : undefined}
						// Marks the modes that already have a conversation.
						data-started={subject.modes.includes(mode) ? "" : undefined}
						className={cn(
							"min-w-24 rounded-md px-4 py-1 text-center text-sm transition-colors",
							current ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{MODE_LABEL[mode]}
					</Link>
				);
			})}
		</nav>
	);
}

/** The small button that opens the subject's Progress view. */
export function ProgressButton({ subject, active = false }: { subject: Pick<SubjectView, "id">; active?: boolean }) {
	return (
		<Hint label="Progress" side="bottom">
			<Link
				href={`/subject/${encodeURIComponent(subject.id)}?view=progress`}
				data-testid="progress-button"
				aria-label="Progress"
				aria-current={active ? "page" : undefined}
				className={cn(
					"lh-no-drag flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
					active ? "bg-accent text-foreground" : "text-muted-foreground",
				)}
			>
				<ChartNoAxesColumnIcon className="size-4" aria-hidden />
			</Link>
		</Hint>
	);
}
