import { afterEach, describe, expect, test, vi } from "vitest";
import {
	ARRIVAL_RATE_ALPHA,
	CATCHUP_WINDOW_MS,
	DEFAULT_SMOOTH_FPS,
	INITIAL_BUFFER_MS,
	MAX_ARRIVAL_SAMPLE_MULTIPLIER,
	MAX_EXTRA_CATCHUP_UNITS_PER_SEC,
	MAX_SMOOTH_FPS,
	MIN_ARRIVAL_UNITS_PER_SEC,
	MIN_SMOOTH_FPS,
	nextStep,
	TARGET_BUFFER_MS,
	updateArrivalRate,
} from "../src/modes/interactive/streaming-reveal.ts";
import { runStreamScenario } from "./helpers/streaming-reveal.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("streaming reveal pacing helpers", () => {
	test("#given adaptive pacing constants #when imported #then pins the UX contract", () => {
		expect(INITIAL_BUFFER_MS).toBe(80);
		expect(TARGET_BUFFER_MS).toBe(140);
		expect(MIN_ARRIVAL_UNITS_PER_SEC).toBe(45);
		expect(MAX_ARRIVAL_SAMPLE_MULTIPLIER).toBe(4);
		expect(MAX_EXTRA_CATCHUP_UNITS_PER_SEC).toBe(600);
		expect(ARRIVAL_RATE_ALPHA).toBe(0.25);
		expect(CATCHUP_WINDOW_MS).toBe(267);
		expect(MIN_SMOOTH_FPS).toBe(30);
		expect(DEFAULT_SMOOTH_FPS).toBe(60);
		expect(MAX_SMOOTH_FPS).toBe(120);
	});

	test("#given a fixed adaptive rate #when stepping at 30 60 and 120fps #then reveal distance is frame-rate independent", () => {
		const revealDistance = (fps: number): number => {
			const dt = 1000 / fps;
			let revealed = 0;
			let carry = 0;
			for (let tick = 0; tick < fps; tick++) {
				carry += nextStep(1000 - revealed, dt, 90);
				const wholeStep = Math.floor(carry);
				carry -= wholeStep;
				revealed += wholeStep;
			}
			return revealed;
		};
		const distances = [MIN_SMOOTH_FPS, DEFAULT_SMOOTH_FPS, MAX_SMOOTH_FPS].map(revealDistance);

		expect(Math.max(...distances) - Math.min(...distances)).toBeLessThanOrEqual(2);
	});

	test("#given varying backlog and arrival rates #when choosing a step #then preserves a target buffer and bounded pace", () => {
		const dt = 1000 / DEFAULT_SMOOTH_FPS;
		const nearTarget = (90 * TARGET_BUFFER_MS) / 1000;

		expect(nextStep(0, dt)).toBe(0);
		expect(nextStep(nearTarget, dt, 90)).toBeCloseTo((90 * dt) / 1000);
		expect(nextStep(1000, dt, 90)).toBeCloseTo(((90 + MAX_EXTRA_CATCHUP_UNITS_PER_SEC) * dt) / 1000);
		expect(nextStep(10, dt, 0)).toBeGreaterThan(0);
		expect(nextStep((500 * TARGET_BUFFER_MS) / 1000, dt, 500)).toBeCloseTo((500 * dt) / 1000);
		expect(nextStep(1000, 0, 90)).toBe(nextStep(1000, 1, 90));
		expect(nextStep(1000, 1000, 90)).toBe(nextStep(1000, 100, 90));
	});

	test("#given a single implausible arrival spike #when updating the EWMA #then the sample is bounded relative to history", () => {
		const updatedRate = updateArrivalRate(90, 10_000, 1);
		const maximumSample = 90 * MAX_ARRIVAL_SAMPLE_MULTIPLIER;
		const expectedRate = 90 + ARRIVAL_RATE_ALPHA * (maximumSample - 90);

		expect(updatedRate).toBe(expectedRate);
	});

	test.each([
		45, 90, 180, 240, 500,
	])("#given a sustained %s unit per second stream #when timed arrivals pass through the controller #then the final tail converges near the target reserve", (rate) => {
		vi.useFakeTimers();
		const result = runStreamScenario({ rate, cadenceMs: 20, durationMs: 5_000 });
		const targetReserve = (rate * TARGET_BUFFER_MS) / 1000;
		const tolerance = result.maxChunk + 2;

		expect(result.finalTail).toBeGreaterThanOrEqual(Math.max(0, targetReserve - tolerance));
		expect(result.finalTail).toBeLessThanOrEqual(targetReserve + tolerance);
	});

	test.each([
		20, 50, 100, 200,
	])("#given equal 90 unit per second streams at %sms cadence #when arrivals continue #then reserve convergence is cadence bounded", (cadenceMs) => {
		vi.useFakeTimers();
		const result = runStreamScenario({ rate: 90, cadenceMs, durationMs: 5_000 });
		const targetReserve = (90 * TARGET_BUFFER_MS) / 1000;
		const tolerance = Math.max(2, result.maxChunk / 2 + 1);

		expect(result.finalTail).toBeGreaterThanOrEqual(Math.max(0, targetReserve - tolerance));
		expect(result.finalTail).toBeLessThanOrEqual(targetReserve + tolerance);
	});

	test("#given a sustained fast provider #when streaming for ten seconds #then the immediate final tail remains bounded", () => {
		vi.useFakeTimers();
		const result = runStreamScenario({ rate: 500, cadenceMs: 20, durationMs: 10_000 });
		const targetReserve = (500 * TARGET_BUFFER_MS) / 1000;

		expect(result.finalTail).toBeLessThanOrEqual(targetReserve + result.maxChunk + 2);
		expect(result.visibleUnits).toBeGreaterThan(result.targetUnits * 0.9);
	});
});
