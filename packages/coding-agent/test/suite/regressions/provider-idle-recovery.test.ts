import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_START_TIMEOUT_MS = 90_000;
const RETRY_PROVIDER_TIMEOUT_MS = 30_000;

type ContinuationInternals = {
	_scheduledContinuationRecompacted: boolean;
	_revalidateScheduledContinuationAdmission(): Promise<void>;
};

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

describe("provider idle recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
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

	it.each([
		["assistant", "queued"],
		["assistant", "empty"],
		["non-assistant", "queued"],
		["non-assistant", "empty"],
	] as const)(
		"keeps timeout retries queue-first after recompaction with a %s tail and %s queue",
		async (tail, queueState) => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
			});
			harnesses.push(harness);
			harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
			harness.agent.streamStartTimeoutMs = DEFAULT_STREAM_START_TIMEOUT_MS;
			const internals = harness.session as unknown as ContinuationInternals;
			vi.spyOn(internals, "_revalidateScheduledContinuationAdmission").mockImplementation(async () => {
				internals._scheduledContinuationRecompacted = true;
				if (tail === "assistant") {
					harness.agent.state.messages = [
						...harness.agent.state.messages,
						fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." }),
					];
					return;
				}
				harness.agent.state.messages = [
					...harness.agent.state.messages,
					{
						role: "custom",
						customType: "compactionSummary",
						content: "accepted retry compaction summary",
						display: false,
						timestamp: Date.now(),
					},
				];
			});
			const queueAwareContinue = vi.spyOn(harness.agent, "continueWithQueuedMessages");
			let queuedInput: Promise<void> | undefined;
			harness.session.subscribe((event) => {
				if (queueState === "queued" && event.type === "auto_retry_start" && queuedInput === undefined) {
					queuedInput = harness.session.steer("queued after timeout");
				}
			});
			harness.setResponses([
				genericTimeoutError(),
				fauxAssistantMessage("recovered after recompaction"),
				fauxAssistantMessage("must not run"),
			]);

			await harness.session.prompt("original request");
			await queuedInput;

			expect(queueAwareContinue).toHaveBeenCalledTimes(1);
			expect(harness.eventsOfType("continuation_error")).toEqual([]);
			const retryUserTexts = [
				"original request",
				...(tail === "non-assistant" ? ["accepted retry compaction summary"] : []),
				...(queueState === "queued" ? ["queued after timeout"] : []),
			];
			expect(getRequestUserTexts(harness)).toEqual([["original request"], retryUserTexts]);
			expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([
				DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
				RETRY_PROVIDER_TIMEOUT_MS,
			]);
			expect(harness.faux.getCallLog().map((call) => getStreamStartTimeoutMs(call.options))).toEqual([
				DEFAULT_STREAM_START_TIMEOUT_MS,
				RETRY_PROVIDER_TIMEOUT_MS,
			]);
		},
	);

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
