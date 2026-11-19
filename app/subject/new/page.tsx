import { NewSession } from "@/components/new-session";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

export const dynamic = "force-dynamic";

/**
 * The New box (papersplainer, owner 2026-11-19): one draft for both kinds.
 * Nothing is created until the first message is sent — a link or a PDF path
 * makes a paper, anything else makes a topic — and that message opens the
 * walkthrough. Static segment beats the dynamic [id] route: "new" is never
 * a subject id.
 */
export default function NewSubjectPage() {
	return <NewSession initialConfigured={slotsConfigured(readSettingsRecord()?.models)} subject={null} />;
}
