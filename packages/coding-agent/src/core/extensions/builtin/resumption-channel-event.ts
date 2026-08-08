export const RESUMPTION_CHANNEL_STATE_EVENT = "resumption_channel_state";

export interface ResumptionChannelEntry {
	readonly id: string;
	readonly description: string;
	readonly startedAtMs: number;
}

export interface ResumptionChannelStateEvent {
	readonly source: string;
	readonly activeCount: number;
	readonly channels?: readonly ResumptionChannelEntry[];
}

export function isResumptionChannelStateEvent(data: unknown): data is ResumptionChannelStateEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		"source" in data &&
		typeof data.source === "string" &&
		data.source.length > 0 &&
		"activeCount" in data &&
		typeof data.activeCount === "number" &&
		Number.isInteger(data.activeCount) &&
		data.activeCount >= 0
	);
}
