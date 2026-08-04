import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_START_TIMEOUT_MS = 90_000;
const RETRY_PROVIDER_TIMEOUT_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function idleTimeoutError() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: `Idle timeout waiting for provider stream after ${DEFAULT_PROVIDER_IDLE_TIMEOUT_MS}ms`,
	});
}

function genericTimeoutError() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "Request timed out.",
	});
}

function getRequestUserTexts(harness: Harness): string[][] {
	return harness.faux
		.getCallLog()
		.map((call) =>
			call.context.messages.filter((message) => message.role === "user").map((message) => getMessageText(message)),
		);
}

function getStreamStartTimeoutMs(options: unknown): number | undefined {
	if (!options || typeof options !== "object" || !("streamStartTimeoutMs" in options)) return undefined;
	const value = (options as { streamStartTimeoutMs?: unknown }).streamStartTimeoutMs;
	return typeof value === "number" ? value : undefined;
}

describe("provider idle steering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("preserves steering until the timed-out retry recovers under configured timeouts", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		harness.setResponses([
			idleTimeoutError(),
			genericTimeoutError(),
			fauxAssistantMessage("original request recovered"),
			fauxAssistantMessage("steering request recovered"),
		]);

		let queuedSteering: Promise<void> | undefined;
		let resolveSteeringResponse: (() => void) | undefined;
		const steeringResponse = new Promise<void>((resolve) => {
			resolveSteeringResponse = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && queuedSteering === undefined) {
				queuedSteering = harness.session.steer("continue");
			}
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				getMessageText(event.message) === "steering request recovered"
			) {
				resolveSteeringResponse?.();
			}
		});

		try {
			await harness.session.prompt("original request");
			await queuedSteering;
			await withTimeout(
				steeringResponse,
				1_000,
				`queued steering response was not produced: ${JSON.stringify(getRequestUserTexts(harness))}`,
			);
		} finally {
			unsubscribe();
		}

		expect(getRequestUserTexts(harness)).toEqual([
			["original request"],
			["original request"],
			["original request"],
			["original request", "continue"],
		]);
		expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			RETRY_PROVIDER_TIMEOUT_MS,
			RETRY_PROVIDER_TIMEOUT_MS,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
		]);
		expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
			DEFAULT_STREAM_START_TIMEOUT_MS,
			RETRY_PROVIDER_TIMEOUT_MS,
			RETRY_PROVIDER_TIMEOUT_MS,
			DEFAULT_STREAM_START_TIMEOUT_MS,
		]);
		expect(getUserTexts(harness)).toEqual(["original request", "continue"]);
	});

	it("retains queued input when a capped retry is aborted in flight", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		const retryRequestStarted = createDeferred();
		let queuedInput: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && queuedInput === undefined) {
				queuedInput = harness.session.steer("retain through retry abort");
			}
		});
		harness.setResponses([
			genericTimeoutError(),
			async (_context, options) => {
				retryRequestStarted.resolve();
				await new Promise<void>((resolve) => {
					const signal = options?.signal;
					if (signal?.aborted) {
						resolve();
						return;
					}
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" });
			},
			fauxAssistantMessage("must not run"),
		]);

		const prompt = harness.session.prompt("original request");
		await retryRequestStarted.promise;
		await queuedInput;
		await harness.session.abort();
		await prompt;
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.faux.getCallLog()[1]?.options?.timeoutMs).toBe(RETRY_PROVIDER_TIMEOUT_MS);
		expect(harness.session.getSteeringMessages()).toEqual(["retain through retry abort"]);
		expect(harness.agent.hasQueuedMessages()).toBe(true);
		expect(harness.eventsOfType("continuation_error")).toEqual([]);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.agent.state.isStreaming).toBe(false);
	});
});
