/**
 * SubjectStore — the fs JSON adapter (one file per paper or topic in
 * data/subjects/). Implements core/ports.ts SubjectStore; the record shape
 * lives in core/contracts/subject.ts. Same idioms as the chat store: sync
 * fs, tiny records, id-guarded filenames, atomic writes. Wired in the
 * composition root (src/server/stores.ts).
 *
 * Every list-shape change (create, rename, delete, a mode gaining its
 * conversation) announces "chats-changed" — the sidebar's one refetch signal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { SubjectStore } from "../core/ports.ts";
import { CURRENT_SUBJECT_VERSION, type SubjectKind, type SubjectMode, type SubjectRecord } from "../core/contracts.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

function subjectFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid subject id: ${id}`);
	return path.join(/* turbopackIgnore: true */ PATHS.subjects, `${id}.json`);
}

function writeSubject(record: SubjectRecord): void {
	fs.mkdirSync(PATHS.subjects, { recursive: true });
	writeFileAtomicSync(subjectFile(record.id), JSON.stringify({ ...record, version: CURRENT_SUBJECT_VERSION }, null, "\t"), { allowInPlaceFallback: true });
}

function createSubject(input: { kind: SubjectKind; title: string; source?: string; paperKey?: string }): SubjectRecord {
	const now = new Date().toISOString();
	const record: SubjectRecord = {
		id: `subj_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		kind: input.kind,
		title: input.title.trim() || (input.kind === "paper" ? "Untitled paper" : "Untitled topic"),
		createdAt: now,
		updatedAt: now,
		...(input.source ? { source: input.source } : {}),
		...(input.paperKey ? { paperKey: input.paperKey } : {}),
		chats: {},
	};
	writeSubject(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_SUBJECT_VERSION };
}

function getSubject(id: string): SubjectRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ subjectFile(id), "utf-8"));
	} catch {
		return null;
	}
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_SUBJECT_VERSION) {
		console.error(`[subject ${id}] record stamped with schema version ${v} > ${CURRENT_SUBJECT_VERSION} — refusing to read it`);
		return null;
	}
	const record = parsed as SubjectRecord;
	if (!record || typeof record !== "object" || typeof record.id !== "string" || typeof record.chats !== "object" || record.chats === null) return null;
	return record;
}

function listSubjects(): SubjectRecord[] {
	try {
		fs.mkdirSync(PATHS.subjects, { recursive: true });
		return fs
			.readdirSync(/* turbopackIgnore: true */ PATHS.subjects)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try { return getSubject(f.slice(0, -5)); } catch { return null; }
			})
			.filter((r): r is SubjectRecord => r !== null);
	} catch {
		return [];
	}
}

/** One synchronous read-modify-write; null when the subject is gone. */
function update(id: string, change: (record: SubjectRecord) => void, announce: boolean): SubjectRecord | null {
	const record = getSubject(id);
	if (!record) return null;
	change(record);
	writeSubject(record);
	if (announce) emit("chats-changed", {});
	return record;
}

function renameSubject(id: string, title: string): SubjectRecord | null {
	return update(id, (r) => { r.title = title.trim() || r.title; }, true);
}

function setChat(id: string, mode: SubjectMode, chatId: string): SubjectRecord | null {
	return update(id, (r) => {
		const previous = r.chats[mode];
		if (previous && previous !== chatId) r.shelved = [...(r.shelved ?? []).filter((c) => c !== previous && c !== chatId), previous];
		r.chats[mode] = chatId;
		r.updatedAt = new Date().toISOString();
	}, true);
}

function shelveChat(id: string, chatId: string): SubjectRecord | null {
	return update(id, (r) => {
		if (!(r.shelved ?? []).includes(chatId)) r.shelved = [...(r.shelved ?? []), chatId];
	}, false);
}

function setPaper(id: string, paper: { paperKey?: string; source?: string; title?: string }): SubjectRecord | null {
	return update(id, (r) => {
		if (paper.paperKey) r.paperKey = paper.paperKey;
		if (paper.source) r.source = paper.source;
		if (paper.title?.trim()) r.title = paper.title.trim();
	}, paper.title !== undefined);
}

/** Drop one conversation from the subject (it was deleted on its own). */
function forgetChat(id: string, chatId: string): SubjectRecord | null {
	return update(id, (r) => {
		for (const mode of Object.keys(r.chats) as SubjectMode[]) if (r.chats[mode] === chatId) delete r.chats[mode];
		if (r.shelved) {
			r.shelved = r.shelved.filter((c) => c !== chatId);
			if (r.shelved.length === 0) delete r.shelved;
		}
	}, true);
}

function deleteSubject(id: string): boolean {
	try {
		fs.unlinkSync(subjectFile(id));
		removeLeftoverTemps(subjectFile(id));
		emit("chats-changed", {});
		return true;
	} catch {
		return false;
	}
}

export const subjectStore: SubjectStore = {
	createSubject,
	getSubject,
	listSubjects,
	renameSubject,
	setChat,
	shelveChat,
	setPaper,
	forgetChat,
	deleteSubject,
};
