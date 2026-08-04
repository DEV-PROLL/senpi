import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_START_TIMEOUT_MS = 90_000;
const RETRY_PROVIDER_TIMEOUT_MS = 30_000;

function createAssistantStream(): EventStream<AssistantMessageEvent, AssistantMessage> {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected non-terminal faux stream event");
		},
	);
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

function getStreamStartTimeoutMs(options: unknown): number | undefined {
	if (!options || typeof options !== "object" || !("streamStartTimeoutMs" in options)) return undefined;
	const value = (options as { streamStartTimeoutMs?: unknown }).streamStartTimeoutMs;
	return typeof value === "number" ? value : undefined;
}

describe("provider idle recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("uses the configured provider stream retry cap", async () => {
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 0,
					provider: { streamRetryTimeoutMs: 45_000 },
				},
			},
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		harness.setResponses([
			idleTimeoutError(),
			fauxAssistantMessage("retry recovered"),
			fauxAssistantMessage("ordinary turn recovered"),
		]);

		await harness.session.prompt("first request");
		await harness.session.prompt("later request");

		expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			45_000,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
		]);
		expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
			DEFAULT_STREAM_START_TIMEOUT_MS,
			45_000,
			DEFAULT_STREAM_START_TIMEOUT_MS,
		]);
	});

	it("does not re-enable disabled stream guards during a timeout retry", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = undefined;
		harness.agent.streamStartTimeoutMs = undefined;
		harness.setResponses([genericTimeoutError(), fauxAssistantMessage("retry recovered")]);

		await harness.session.prompt("first request");

		expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([undefined, undefined]);
		expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
			undefined,
			undefined,
		]);
	});

	it("does not apply provider timeout policy to incidental extension timeout text", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "extension timed out" }),
			fauxAssistantMessage("generic retry recovered"),
		]);

		await harness.session.prompt("first request");

		expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
		]);
		expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
			DEFAULT_STREAM_START_TIMEOUT_MS,
			DEFAULT_STREAM_START_TIMEOUT_MS,
		]);
	});

	it("does not retry unrelated aborted timeout text", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Command timed out after 30000ms" }),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("first request");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("expires a no-first-event retry at the retry cap instead of the configured start timeout", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
		const providerOptions: Array<{ timeoutMs?: number; streamStartTimeoutMs?: number }> = [];
		const secondRequestStarted = createDeferred();
		let providerCalls = 0;
		harness.agent.streamFunction = (_model, _context, options) => {
			providerCalls++;
			providerOptions.push({
				timeoutMs: options?.timeoutMs,
				streamStartTimeoutMs: getStreamStartTimeoutMs(options),
			});
			const stream = createAssistantStream();
			if (providerCalls === 1) {
				queueMicrotask(() => {
					const error = idleTimeoutError();
					stream.push({ type: "error", reason: "error", error });
				});
			} else {
				secondRequestStarted.resolve();
			}
			return stream;
		};
		const retryStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "auto_retry_start") return;
				unsubscribe();
				resolve();
			});
		});

		const prompt = harness.session.prompt("first request");
		try {
			await retryStarted;
			await vi.runOnlyPendingTimersAsync();
			await secondRequestStarted.promise;
			await vi.advanceTimersByTimeAsync(RETRY_PROVIDER_TIMEOUT_MS - 1);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([]);

			await vi.advanceTimersByTimeAsync(1);
			await vi.advanceTimersByTimeAsync(0);

			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
			expect(providerOptions).toEqual([
				{
					timeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
					streamStartTimeoutMs: DEFAULT_STREAM_START_TIMEOUT_MS,
				},
				{ timeoutMs: RETRY_PROVIDER_TIMEOUT_MS, streamStartTimeoutMs: RETRY_PROVIDER_TIMEOUT_MS },
			]);
			const finalAssistant = harness
				.eventsOfType("message_end")
				.map((event) => event.message)
				.filter((message): message is AssistantMessage => message.role === "assistant")
				.at(-1);
			expect(finalAssistant?.errorMessage).toBe(
				`Provider stream start timed out after ${RETRY_PROVIDER_TIMEOUT_MS}ms`,
			);
		} finally {
			if (harness.session.isStreaming) await harness.session.abort();
			await prompt;
		}
	});
});
