import Link from "next/link";
import { agentOverview } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * "How the agents work" (papersplainer, Michael 2026-11-24): the agents'
 * instructions, moved out of Settings. Read-only by his choice: a one-line
 * summary per agent, the full text one click away, no editing in the app.
 */
export default function HowItWorksPage() {
	const entries = agentOverview();
	return (
		<main data-testid="how-it-works" className="h-full min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
				<header className="flex flex-col gap-2">
					<Link href="/" className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Back</Link>
					<h1 className="font-title text-2xl font-semibold text-foreground">How the agents work</h1>
					<p className="text-sm text-muted-foreground">
						Each mode is run by an agent that follows written instructions. This page shows who does what and the exact text each one is given. It is for reading only.
					</p>
				</header>
				{entries.map((entry) => (
					<section key={entry.id} data-testid={`agent-${entry.id}`} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
						<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
							<h2 className="text-base font-semibold text-foreground">{entry.name}</h2>
							<span className="text-xs text-muted-foreground">{entry.where}</span>
						</div>
						<p className="text-sm text-foreground">{entry.summary}</p>
						<details data-testid={`agent-${entry.id}-text`}>
							<summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
								Show full text ({entry.parts.length} {entry.parts.length === 1 ? "part" : "parts"})
							</summary>
							<div className="mt-3 flex flex-col gap-4">
								{entry.parts.map((part) => (
									<div key={part.path ?? part.title} className="flex flex-col gap-1">
										<p className="text-xs font-medium text-foreground">
											{part.title}
											{part.path && <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">{part.path}</span>}
											{part.overridden && <span className="ml-2 font-normal text-muted-foreground">Your saved version is in use</span>}
										</p>
										<pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-muted p-3 font-ui text-xs leading-relaxed text-muted-foreground">{part.text}</pre>
									</div>
								))}
							</div>
						</details>
					</section>
				))}
			</div>
		</main>
	);
}
