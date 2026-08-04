import type { AgentContinuationOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { isProviderTimeoutError } from "@earendil-works/pi-ai/compat";

export interface ProviderTimeoutRetryPlan {
	options: AgentContinuationOptions;
	watchdogTimeoutMs: number | undefined;
}

export interface ProviderTimeoutRetryPlanInput {
	message: AssistantMessage;
	streamRetryTimeoutMs: number | undefined;
	timeoutMs: number | undefined;
	streamStartTimeoutMs: number | undefined;
}

export interface BoundedRetryContinuation {
	continueRun(): Promise<void>;
	getActiveSignal(): AbortSignal | undefined;
	abortActive(): void;
	timeoutMs: number | undefined;
}

export function createProviderTimeoutRetryPlan({
	message,
	streamRetryTimeoutMs,
	timeoutMs,
	streamStartTimeoutMs,
}: ProviderTimeoutRetryPlanInput): ProviderTimeoutRetryPlan {
	if (!isProviderTimeoutError(message)) {
		return { options: {}, watchdogTimeoutMs: undefined };
	}

	const capEnabledBound = (configuredMs: number | undefined): number | undefined => {
		if (streamRetryTimeoutMs === undefined || configuredMs === undefined) return undefined;
		return Math.min(configuredMs, streamRetryTimeoutMs);
	};
	const boundedTimeoutMs = capEnabledBound(timeoutMs);
	const boundedStreamStartTimeoutMs = capEnabledBound(streamStartTimeoutMs);
	return {
		options: {
			deferQueuedMessages: true,
			...(boundedTimeoutMs === undefined ? {} : { timeoutMs: boundedTimeoutMs }),
			...(boundedStreamStartTimeoutMs === undefined ? {} : { streamStartTimeoutMs: boundedStreamStartTimeoutMs }),
		},
		watchdogTimeoutMs:
			boundedTimeoutMs === undefined && boundedStreamStartTimeoutMs === undefined ? streamRetryTimeoutMs : undefined,
	};
}

export async function runBoundedRetryContinuation({
	continueRun,
	getActiveSignal,
	abortActive,
	timeoutMs,
}: BoundedRetryContinuation): Promise<void> {
	const continuation = continueRun();
	const ownedSignal = getActiveSignal();
	if (timeoutMs === undefined || ownedSignal === undefined) {
		await continuation;
		return;
	}

	const timer = setTimeout(() => {
		if (getActiveSignal() === ownedSignal) {
			abortActive();
		}
	}, timeoutMs);
	try {
		await continuation;
	} finally {
		clearTimeout(timer);
	}
}
