import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 300_000;
const RETRY_PROVIDER_IDLE_TIMEOUT_MS = 30_000;

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

describe("provider idle recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("preserves steering until the timed-out retry recovers", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
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
				JSON.stringify(event.message.content).includes("steering request recovered")
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
				`queued steering response was not produced: ${JSON.stringify(
					harness.faux.getCallLog().map((call) => call.context.messages),
				)}`,
			);
		} finally {
			unsubscribe();
		}

		const requests = harness.faux.getCallLog().map((call) => JSON.stringify(call.context.messages));
		expect(requests).toHaveLength(4);
		expect(requests[1]).toContain("original request");
		expect(requests[1]).not.toContain("continue");
		expect(requests[2]).toContain("original request");
		expect(requests[2]).not.toContain("continue");
		expect(requests[3]).toContain("continue");
		expect(getUserTexts(harness)).toEqual(["original request", "continue"]);
	});

	it("caps only automatic idle-timeout retries", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.agent.timeoutMs = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
		harness.setResponses([
			idleTimeoutError(),
			fauxAssistantMessage("retry recovered"),
			fauxAssistantMessage("ordinary turn recovered"),
		]);

		await harness.session.prompt("first request");
		await harness.session.prompt("later request");

		expect(harness.faux.getCallLog().map((call) => call.options?.timeoutMs)).toEqual([
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
			RETRY_PROVIDER_IDLE_TIMEOUT_MS,
			DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
		]);
	});
});
