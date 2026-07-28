export const TERMINAL_MONITOR_STATE_EVENT = "terminal_monitor_state";

export interface TerminalMonitorStateEvent {
	readonly activeCount: number;
}

export function isTerminalMonitorStateEvent(data: unknown): data is TerminalMonitorStateEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		"activeCount" in data &&
		typeof data.activeCount === "number" &&
		Number.isInteger(data.activeCount) &&
		data.activeCount >= 0
	);
}
