"use client";

import { useContext } from "react";
import { DownloadIcon } from "lucide-react";
import { ChatActionsContext } from "@/components/chat";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { isCacheFileName, type ArtifactPartProps, type ToyDataResult } from "@/src/core";

/**
 * papersplainer: the toy dataset card. The dispatch side is the shared
 * DispatchCard. The delivered side lists each file with its format, what
 * the checker counted, and its opening lines (collapsed), plus a download.
 */

export function ToyDataCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="dataset" />;
}

export function ToyDataOutputCard({ output }: { output: unknown }) {
	const result = output as ToyDataResult | undefined;
	const chatId = useContext(ChatActionsContext)?.chatId;
	if (!result || !Array.isArray(result.files)) {
		return <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">Toy dataset completed, but the result could not be displayed.</div>;
	}
	if (result.files.length === 0) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="toy-data-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Toy data
					<span className="rounded bg-error/15 px-1.5 py-0.5 text-error">failed</span>
				</div>
				<p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{result.notes ?? "The toy dataset could not be made."}</p>
			</div>
		);
	}
	return (
		<div className="my-4 rounded-xl border bg-card p-4 text-card-foreground" data-testid="toy-data-card">
			<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
				<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Toy data</span>
				<span className="text-sm">{result.title}</span>
				{result.reused && <span className="text-xs text-muted-foreground">· reused from an earlier session on this paper</span>}
			</div>
			<p className="mt-1 text-xs text-muted-foreground">
				Illustrative files in the study&apos;s formats. Not the study&apos;s real data.
			</p>
			<ul className="mt-3 space-y-2">
				{result.files.map((file) => {
					const href = chatId && isCacheFileName(file.name) ? `/api/chats/${encodeURIComponent(chatId)}/paper-data/${encodeURIComponent(file.name)}` : null;
					return (
						<li key={file.name} data-testid="toy-data-file">
							<details className="group rounded-lg border bg-background">
								<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
									<span className="font-mono">{file.name}</span>
									<span className="rounded bg-accent px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{file.format}</span>
									<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
										{file.summary}{file.checked ? "" : " · not format-checked"}
									</span>
									{href && (
										<a
											href={href}
											download={file.name}
											aria-label={`Download ${file.name}`}
											title={`Download ${file.name}`}
											onClick={(e) => e.stopPropagation()}
											className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
										>
											<DownloadIcon className="size-3.5" />
										</a>
									)}
								</summary>
								<pre className="overflow-x-auto border-t px-3 py-2 font-mono text-xs leading-relaxed">{file.preview}</pre>
							</details>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
