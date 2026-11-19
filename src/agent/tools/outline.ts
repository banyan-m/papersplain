import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { OutlineDetails } from "../../core/subject-progress.ts";

/**
 * papersplainer: outline. The walkthrough's record of where it is: the
 * sections the guide will go through, and the one it is starting now.
 * Instant and model-free. Nothing is stored anywhere but the call itself —
 * the learner's Progress view and the sidebar read the most recent clean
 * call from the transcript (core/subject-progress.ts), the same way plan
 * position derives from calls.
 */

const outlineInput = Type.Object({
	sections: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
		minItems: 1,
		maxItems: 40,
		description: "Every section of the walkthrough, in the order you will cover them: short titles (\"The diffusion module\", \"Figure 3: ablations\"). Send the whole list every time.",
	}),
	current: Type.Integer({ minimum: 1, description: "Which section you are starting now, counted from 1." }),
});

export const outlineTool: AgentTool<typeof outlineInput> = {
	name: "outline",
	label: "outline",
	description:
		"Record the walkthrough's outline and where you are in it. Instant. Call it once the paper has been mapped, with the sections " +
		"you will go through and current: 1; then again each time you start the next section, with the same list and the new number. " +
		"If the plan changes, send the changed list. The learner sees this as his progress through the paper. Walkthrough mode only.",
	parameters: outlineInput,
	execute: serverExecute("outline", outlineInput, ({ sections, current }): { text: string; details: OutlineDetails } => {
		const titles = sections.map((s) => s.trim()).filter((s) => s !== "");
		if (titles.length === 0) throw new Error("sections must contain at least one non-empty title");
		if (current > titles.length) throw new Error(`current is ${current} but there are only ${titles.length} sections`);
		return { text: `Recorded: section ${current} of ${titles.length}, "${titles[current - 1]}".`, details: { sections: titles, current } };
	}),
};
