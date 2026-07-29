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
	return harness.faux.getCallLog().map((call) =>
		call.context.messages
			.filter((message) => message.role === "user")
			.map((message) => getMessageText(message)),
	);
}

describe("provider idle recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
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
		expect(harness.faux.getCallLog().map((call) => call.options?.streamStartTimeoutMs)).toEqual([
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
		expect(harness.faux.getCallLog().map((call) => call.options?.streamStartTimeoutMs)).toEqual([
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
		expect(harness.faux.getCallLog().map((call) => call.options?.streamStartTimeoutMs)).toEqual([
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
		expect(harness.faux.getCallLog().map((call) => call.options?.streamStartTimeoutMs)).toEqual([
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
				streamStartTimeoutMs: options?.streamStartTimeoutMs,
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
