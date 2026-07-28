import type { AssistantMessage } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { DEFAULT_SMOOTH_FPS, StreamingRevealController } from "../../src/modes/interactive/streaming-reveal.ts";

export function makeMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "errorMessage" | "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
		timestamp: 0,
	};
}

export function textAt(message: AssistantMessage, index = 0): string {
	const block = message.content[index];
	if (block?.type !== "text") throw new TypeError(`Expected text block at index ${index}`);
	return block.text;
}

export function thinkingAt(message: AssistantMessage, index = 0): string {
	const block = message.content[index];
	if (block?.type !== "thinking") throw new TypeError(`Expected thinking block at index ${index}`);
	return block.thinking;
}

export class RecordingComponent {
	readonly messages: AssistantMessage[] = [];

	updateContent(message: AssistantMessage): void {
		this.messages.push(message);
	}
}

export function latestMessage(component: RecordingComponent): AssistantMessage {
	const message = component.messages.at(-1);
	if (!message) throw new Error("Expected at least one rendered message");
	return message;
}

export type ControllerHarness = {
	readonly component: RecordingComponent;
	readonly controller: StreamingRevealController;
	readonly requestRender: ReturnType<typeof vi.fn>;
};

export type StreamScenario = {
	readonly cadenceMs: number;
	readonly durationMs: number;
	readonly rate: number;
};

export type StreamScenarioResult = {
	readonly finalTail: number;
	readonly maxChunk: number;
	readonly targetUnits: number;
	readonly visibleUnits: number;
};

export function makeController(
	options: {
		readonly fps?: () => number;
		readonly hideThinking?: () => boolean;
		readonly smooth?: () => boolean;
	} = {},
): ControllerHarness {
	const component = new RecordingComponent();
	const requestRender = vi.fn();
	const controller = new StreamingRevealController({
		getSmoothStreaming: options.smooth ?? (() => true),
		getSmoothStreamingFps: options.fps ?? (() => DEFAULT_SMOOTH_FPS),
		getHideThinkingBlock: options.hideThinking ?? (() => false),
		requestRender,
	});
	return { component, controller, requestRender };
}

export function runStreamScenario({ cadenceMs, durationMs, rate }: StreamScenario): StreamScenarioResult {
	const fps = 100;
	const frameMs = 1000 / fps;
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const { component, controller } = makeController({ fps: () => fps });
	controller.begin(component, makeMessage([{ type: "text", text: "" }]));

	let maxChunk = 0;
	let targetUnits = 0;
	let nextChunkAt = cadenceMs;
	for (let elapsed = frameMs; elapsed < durationMs; elapsed += frameMs) {
		now = elapsed;
		if (elapsed + Number.EPSILON >= nextChunkAt) {
			const nextTargetUnits = Math.floor((rate * nextChunkAt) / 1000);
			maxChunk = Math.max(maxChunk, nextTargetUnits - targetUnits);
			targetUnits = nextTargetUnits;
			controller.setTarget(makeMessage([{ type: "text", text: "x".repeat(targetUnits) }]));
			nextChunkAt += cadenceMs;
		}
		vi.advanceTimersByTime(frameMs);
	}

	now = durationMs;
	const finalTargetUnits = Math.floor((rate * durationMs) / 1000);
	maxChunk = Math.max(maxChunk, finalTargetUnits - targetUnits);
	targetUnits = finalTargetUnits;
	controller.setTarget(makeMessage([{ type: "text", text: "x".repeat(targetUnits) }]));
	const visibleUnits = textAt(latestMessage(component)).length;
	controller.stop();

	return {
		finalTail: targetUnits - visibleUnits,
		maxChunk,
		targetUnits,
		visibleUnits,
	};
}
