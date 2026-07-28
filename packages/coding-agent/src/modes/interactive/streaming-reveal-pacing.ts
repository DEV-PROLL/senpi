export const INITIAL_BUFFER_MS = 80;
export const TARGET_BUFFER_MS = 140;
export const CATCHUP_WINDOW_MS = 267;
export const MIN_ARRIVAL_UNITS_PER_SEC = 45;
export const MAX_ARRIVAL_SAMPLE_MULTIPLIER = 4;
export const MAX_EXTRA_CATCHUP_UNITS_PER_SEC = 600;
export const ARRIVAL_RATE_ALPHA = 0.25;
export const MIN_SMOOTH_FPS = 30;
export const MAX_SMOOTH_FPS = 120;
export const DEFAULT_SMOOTH_FPS = 60;

export function updateArrivalRate(currentRate: number, appendedUnits: number, elapsedMs: number): number {
	if (appendedUnits <= 0 || elapsedMs <= 0) return currentRate;
	const sampleRate = (appendedUnits * 1000) / elapsedMs;
	const maximumSample = Math.max(MIN_ARRIVAL_UNITS_PER_SEC, currentRate * MAX_ARRIVAL_SAMPLE_MULTIPLIER);
	const boundedSample = Math.min(maximumSample, Math.max(MIN_ARRIVAL_UNITS_PER_SEC, sampleRate));
	return currentRate + ARRIVAL_RATE_ALPHA * (boundedSample - currentRate);
}

export function nextStep(backlog: number, dtMs: number, arrivalRate = 90): number {
	if (backlog <= 0) return 0;
	const dt = Math.min(Math.max(dtMs, 1), 100);
	const baseArrivalRate = Math.max(MIN_ARRIVAL_UNITS_PER_SEC, arrivalRate);
	const targetBacklog = (baseArrivalRate * TARGET_BUFFER_MS) / 1000;
	const backlogError = backlog - targetBacklog;
	const correctionRate = Math.min(
		MAX_EXTRA_CATCHUP_UNITS_PER_SEC,
		Math.max(-baseArrivalRate, backlogError * (1000 / CATCHUP_WINDOW_MS)),
	);
	const revealRate = Math.max(0, baseArrivalRate + correctionRate);
	return Math.min(backlog, (revealRate * dt) / 1000);
}
