import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { slotsConfigured } from "@/src/core";
import { SubjectRedirect } from "@/components/subject-redirect";
import { modeOfChat, subjectHref } from "@/src/core";
import { compactionInFlight, getChat, getSubject, isTurnRunning, readSettingsRecord, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	const chat = getChat(id);
	if (!chat) notFound();
	// papersplainer: a conversation shown inside a paper or topic is reached
	// through that subject. Old links (citations, the activity dock) land
	// here and are sent on. A shelved conversation (one that lost its mode
	// slot during conversion) has no place there and still opens on its own.
	const subject = chat.subjectId ? getSubject(chat.subjectId) : null;
	const mode = modeOfChat(chat);
	if (subject && subject.chats[mode] === chat.id) return <SubjectRedirect to={subjectHref(subject.id, mode)} />;
	// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
	// over the settings record, server-read — the same gate home/new read. The
	// server's 503 stays the truth; this only decides whether the pill rides.
	const record = readSettingsRecord();
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			paperMode={chat.kind === "paper" ? chat.paperMode ?? "walkthrough" : undefined}
			// Wave D: the record IS native agent history — the client view is
				// derived app-side (core/view.ts projectView; GET serves the same
				// native messages).
				initialMessages={chat.messages}
			initialError={turnFailure(chat.id)}
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={isTurnRunning(chat.id)}
			initiallyCompacting={compactionInFlight(chat.id)}
		/>
	);
}
