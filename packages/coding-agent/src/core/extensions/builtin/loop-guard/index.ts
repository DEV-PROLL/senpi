import type { ExtensionAPI } from "../../types.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../monitor-state-event.ts";
import { detectLoop, NoticeGate } from "./detectors.ts";
import { IdenticalLoopEscalation } from "./escalation.ts";
import {
	buildLoopGuardBlockReason,
	buildLoopGuardHardStopSteer,
	buildLoopGuardHardStopWarning,
	buildLoopGuardReminder,
	LOOP_GUARD_ESCALATION_CUSTOM_TYPE,
	LOOP_GUARD_NOTICE_CUSTOM_TYPE,
	LOOP_GUARD_RECOVERY_CUSTOM_TYPE,
} from "./notice.ts";
import { renderLoopGuardEscalation, renderLoopGuardNotice } from "./renderer.ts";
import { ToolCallTracker } from "./tracker.ts";

const LOOP_GUARD_HARD_STOP_WAKE_SOURCE = "loop-guard-hard-stop";

export default function loopGuardExtension(pi: ExtensionAPI): void {
	const tracker = new ToolCallTracker();
	const gate = new NoticeGate();
	const escalation = new IdenticalLoopEscalation();
	let pendingRecoveryToolName: string | undefined;
	let recoveryWakeSourceActive = false;

	const setRecoveryWakeSourceActive = (active: boolean): void => {
		if (recoveryWakeSourceActive === active) return;
		recoveryWakeSourceActive = active;
		pi.events?.emit(WAKE_SOURCE_STATE_EVENT, {
			source: LOOP_GUARD_HARD_STOP_WAKE_SOURCE,
			activeCount: active ? 1 : 0,
		});
	};

	const reset = (): void => {
		tracker.reset();
		gate.reset();
		escalation.reset();
		pendingRecoveryToolName = undefined;
		setRecoveryWakeSourceActive(false);
	};

	pi.registerMessageRenderer(LOOP_GUARD_NOTICE_CUSTOM_TYPE, renderLoopGuardNotice);
	pi.registerMessageRenderer(LOOP_GUARD_ESCALATION_CUSTOM_TYPE, renderLoopGuardEscalation);

	pi.on("session_start", () => reset());
	pi.on("session_shutdown", () => reset());

	pi.on("input", (event) => {
		if (event.source !== "extension") reset();
	});

	pi.on("tool_execution_start", (event) => {
		const record = tracker.record(event.toolName, event.args);
		escalation.observeAttempt(event.toolCallId, record);
		const detection = detectLoop(tracker.records, gate);
		if (detection === undefined) return;
		escalation.observeNotice(detection);
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

	pi.on("turn_end", () => {
		escalation.finishTurn();
	});

	pi.on("tool_call", (event, ctx) => {
		const decision = escalation.consumeToolCall(event.toolCallId);
		switch (decision.kind) {
			case "allow":
				return undefined;
			case "block":
				return {
					block: true,
					reason: buildLoopGuardBlockReason(decision.toolName, decision.blockedCallCount),
					terminate: false,
				};
			case "hardStop": {
				const warning = buildLoopGuardHardStopWarning(decision.toolName, decision.blockedCallCount);
				if (decision.announce) {
					setRecoveryWakeSourceActive(true);
					pi.sendMessage(
						{
							customType: LOOP_GUARD_ESCALATION_CUSTOM_TYPE,
							content: warning,
							display: true,
							details: {
								toolName: decision.toolName,
								blockedCallCount: decision.blockedCallCount,
							},
						},
						{ triggerTurn: false, deliverAs: "steer" },
					);
					if (ctx.hasUI) ctx.ui.notify(warning, "warning");
					pendingRecoveryToolName = decision.toolName;
				}
				ctx.abort("system");
				return {
					block: true,
					reason: buildLoopGuardBlockReason(decision.toolName, decision.blockedCallCount),
					terminate: false,
				};
			}
		}
	});

	pi.on("agent_start", () => {
		setRecoveryWakeSourceActive(false);
	});

	pi.on("agent_settled", () => {
		const toolName = pendingRecoveryToolName;
		if (toolName === undefined) return;
		pendingRecoveryToolName = undefined;
		pi.sendMessage(
			{
				customType: LOOP_GUARD_RECOVERY_CUSTOM_TYPE,
				content: buildLoopGuardHardStopSteer(toolName),
				display: false,
			},
			{ triggerTurn: true },
		);
	});
}
