"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * An old session address (/chat/<id>) for a conversation that now lives
 * inside a paper or topic: replace it with the subject's address, keeping
 * the #message anchor (a server redirect cannot see the fragment, and
 * citation and activity links carry one).
 */
export function SubjectRedirect({ to }: { to: string }) {
	const router = useRouter();
	useEffect(() => {
		router.replace(`${to}${window.location.hash}`);
	}, [router, to]);
	return null;
}
