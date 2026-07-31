import type { ExtensionAPI } from "../../types.ts";
import { detectLoop, NoticeGate } from "./detectors.ts";
import { buildLoopGuardReminder, LOOP_GUARD_NOTICE_CUSTOM_TYPE } from "./notice.ts";
import { renderLoopGuardNotice } from "./renderer.ts";
import { ToolCallTracker } from "./tracker.ts";

export default function loopGuardExtension(pi: ExtensionAPI): void {
	const tracker = new ToolCallTracker();
	const gate = new NoticeGate();

	const reset = (): void => {
		tracker.reset();
		gate.reset();
	};

	pi.registerMessageRenderer(LOOP_GUARD_NOTICE_CUSTOM_TYPE, renderLoopGuardNotice);

	pi.on("session_start", () => reset());

	pi.on("input", (event) => {
		if (event.source !== "extension") reset();
	});

	pi.on("tool_execution_start", (event) => {
		tracker.record(event.toolName, event.args);
		const detection = detectLoop(tracker.records, gate);
		if (detection === undefined) return;
		pi.sendMessage(
			{
				customType: LOOP_GUARD_NOTICE_CUSTOM_TYPE,
				content: buildLoopGuardReminder(detection),
				display: true,
				details: detection,
			},
			{ triggerTurn: false, deliverAs: "steer" },
		);
	});
}
