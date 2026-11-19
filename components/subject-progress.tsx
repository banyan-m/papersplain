"use client";

/**
 * The Progress view of one paper or topic (papersplainer, owner 2026-11-19).
 * First version: only what the conversations already recorded — how far the
 * walkthrough is, how practice went, what was added to the map. Nothing here
 * calls a model or judges understanding. The body is a pure function of its
 * data (exported for render tests); the page supplies the header.
 */

import Link from "next/link";
import { CheckIcon } from "lucide-react";
import { subjectHref, stepPosition, PRACTICE_OUTCOMES, type PracticeOutcome, type SubjectProgress } from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { ModeSwitch, ProgressButton, type SubjectView } from "@/components/mode-switch";
import { cn } from "@/lib/utils";

const OUTCOME_LABEL: Record<PracticeOutcome, string> = {
	solved: "Solved",
	solvedWithHints: "Solved with hints",
	movedOn: "Moved on",
	surrendered: "Gave up",
	dismissed: "Dismissed",
};

function Section({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
	return (
		<section className="border-t border-border/60 py-6 first:border-t-0 first:pt-0">
			<div className="mb-3 flex items-baseline justify-between gap-4">
				<h2 className="text-sm font-medium text-foreground">{title}</h2>
				{aside && <span className="text-xs text-muted-foreground">{aside}</span>}
			</div>
			{children}
		</section>
	);
}

function Empty({ children }: { children: React.ReactNode }) {
	return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function SubjectProgressBody({ subject, progress }: { subject: Pick<SubjectView, "id" | "kind">; progress: SubjectProgress }) {
	const paper = subject.kind === "paper";
	const position = stepPosition(progress.steps);
	const practice = progress.practice;
	const concluded = practice ? PRACTICE_OUTCOMES.reduce((n, o) => n + practice.outcomes[o], 0) : 0;
	return (
		<div data-testid="subject-progress" className="mx-auto w-full max-w-2xl px-6 py-8 font-prose">
			<Section
				title="Walkthrough"
				aside={position ? `${paper ? "Section" : "Step"} ${position.current} of ${position.total}` : undefined}
			>
				{progress.steps ? (
					<ol className="flex flex-col gap-1.5" data-testid="progress-steps">
						{progress.steps.map((step, i) => (
							<li key={i} data-state={step.state} className="flex items-start gap-3 text-sm">
								<span
									aria-hidden
									className={cn(
										"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
										step.state === "done" && "border-transparent bg-accent text-foreground",
										step.state === "current" && "border-foreground",
										step.state === "upcoming" && "border-border",
									)}
								>
									{step.state === "done" ? <CheckIcon className="size-3" /> : step.state === "current" ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
								</span>
								<span className={cn("min-w-0", step.state === "upcoming" ? "text-muted-foreground" : "text-foreground", step.state === "current" && "font-medium")}>
									{step.title}
									<span className="sr-only">{step.state === "done" ? " (covered)" : step.state === "current" ? " (you are here)" : " (not yet)"}</span>
									{step.summary && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{step.summary}</span>}
								</span>
							</li>
						))}
					</ol>
				) : (
					<Empty>
						{paper
							? "The sections appear here once the walkthrough has mapped the paper."
							: "The plan appears here once the walkthrough has found out what you know and laid out the steps."}{" "}
						<Link href={subjectHref(subject.id, "walkthrough")} className="text-foreground underline-offset-4 hover:underline">Open the walkthrough</Link>
					</Empty>
				)}
			</Section>

			<Section title="Practice" aside={practice && practice.posed > 0 ? `${practice.posed} ${practice.posed === 1 ? "problem" : "problems"}` : undefined}>
				{practice && practice.posed > 0 ? (
					<>
						{concluded > 0 && (
							<dl className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="practice-outcomes">
								{PRACTICE_OUTCOMES.filter((o) => practice.outcomes[o] > 0).map((o) => (
									<div key={o} className="flex items-baseline gap-1.5">
										<dd className="font-medium tabular-nums text-foreground">{practice.outcomes[o]}</dd>
										<dt className="text-muted-foreground">{OUTCOME_LABEL[o].toLowerCase()}</dt>
									</div>
								))}
							</dl>
						)}
						<ul className="flex flex-col gap-1.5">
							{practice.recent.map((problem, i) => (
								<li key={i} className="flex items-baseline justify-between gap-4 text-sm">
									<span className="min-w-0 truncate text-foreground">{problem.statement || "Untitled problem"}</span>
									<span className="shrink-0 text-xs text-muted-foreground">{problem.outcome ? OUTCOME_LABEL[problem.outcome] : "In progress"}</span>
								</li>
							))}
						</ul>
					</>
				) : (
					<Empty>
						No problems yet.{" "}
						<Link href={subjectHref(subject.id, "practice")} className="text-foreground underline-offset-4 hover:underline">Open practice</Link>
					</Empty>
				)}
			</Section>

			<Section title="Concepts" aside={progress.concepts.length > 0 ? `${progress.concepts.length} on your map` : undefined}>
				{progress.concepts.length > 0 ? (
					<ul className="flex flex-col gap-3" data-testid="progress-concepts">
						{progress.concepts.map((concept) => (
							<li key={concept.id} className="text-sm">
								<span className="font-medium text-foreground">{concept.name}</span>
								<span className="mt-0.5 block text-muted-foreground">{concept.statement}</span>
							</li>
						))}
					</ul>
				) : (
					<Empty>Ideas from these conversations are added to your map as you go, and listed here.</Empty>
				)}
			</Section>
		</div>
	);
}

/** The whole view: the subject's header (name, mode switch with no mode
 *  selected, the Progress button lit) over the body. */
export function SubjectProgressView({ subject, progress }: { subject: SubjectView; progress: SubjectProgress }) {
	return (
		<div className="flex h-dvh flex-col">
			<TopBar center={<ModeSwitch subject={subject} none />}>
				<span className="min-w-4 max-w-[calc(50%-11rem)] shrink truncate font-title text-base text-muted-foreground">{subject.title}</span>
				<div className="min-w-4 flex-1" aria-hidden="true" />
				<ProgressButton subject={subject} active />
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<SubjectProgressBody subject={subject} progress={progress} />
			</div>
		</div>
	);
}
