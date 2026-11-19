import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { NewSession } from "@/components/new-session";
import { SubjectProgressView } from "@/components/subject-progress";
import type { SubjectView } from "@/components/mode-switch";
import { SUBJECT_MODES, chatShapeFor, isSubjectMode, slotsConfigured } from "@/src/core";
import { compactionInFlight, defaultModeOf, getSubject, isTurnRunning, readSettingsRecord, subjectChat, subjectProgress, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * One paper or topic (papersplainer, owner 2026-11-19). ?mode= picks which
 * of its conversations is on screen (walkthrough, chat, practice); absent,
 * the mode touched most recently. A mode with a conversation renders it; a
 * mode without one renders its first screen, and the conversation is
 * created when the first message is sent.
 */
export default async function SubjectPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ mode?: string; view?: string }>;
}) {
	const [{ id }, query] = await Promise.all([params, searchParams]);
	const subject = getSubject(id);
	if (!subject) notFound();
	const mode = isSubjectMode(query.mode) ? query.mode : defaultModeOf(subject);
	const view: SubjectView = {
		id: subject.id,
		kind: subject.kind,
		title: subject.title,
		mode,
		modes: SUBJECT_MODES.filter((m) => subjectChat(subject, m) !== null),
	};
	// ?view=progress: the fourth view — not a conversation.
	if (query.view === "progress") return <SubjectProgressView subject={view} progress={subjectProgress(subject)} />;
	const configured = slotsConfigured(readSettingsRecord()?.models);
	const chat = subjectChat(subject, mode);
	if (!chat) {
		const shape = chatShapeFor(subject.kind, mode);
		return <NewSession key={`${subject.id}:${mode}`} initialConfigured={configured} subject={view} mode={shape.kind} initialPaperMode={shape.paperMode} />;
	}
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			subject={view}
			title={subject.title}
			kind={chat.kind ?? "teach"}
			paperMode={chat.kind === "paper" ? chat.paperMode ?? "walkthrough" : undefined}
			initialMessages={chat.messages}
			initialError={turnFailure(chat.id)}
			initialConfigured={configured}
			initiallyInFlight={isTurnRunning(chat.id)}
			initiallyCompacting={compactionInFlight(chat.id)}
		/>
	);
}
