export interface OperationSettler {
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

export interface WriteOperation {
	readonly kind: "write";
	readonly payload: string;
	readonly settlers: OperationSettler[];
}

export interface ReplayOperation {
	readonly kind: "replay";
	payload: string;
	readonly settlers: OperationSettler[];
}

export interface ResizeOperation {
	readonly kind: "resize";
	readonly cols: number;
	readonly rows: number;
	readonly replay: string;
	readonly settlers: OperationSettler[];
}

export type ScreenOperation = WriteOperation | ReplayOperation | ResizeOperation;

/**
 * Ceiling for characters queued but not yet parsed by xterm. Beyond it the
 * queued writes collapse into one bounded history replay, so a flooding PTY
 * can neither overrun xterm's 50M-char pending-write watermark (which rejects
 * with "write data discarded, use flow control to avoid losing data") nor
 * grow the queue's memory without limit.
 */
export const MAX_PENDING_WRITE_CHARS = 1_048_576;

export function settleOperation(settlers: OperationSettler[], error: Error | null): void {
	const owners = settlers.splice(0, settlers.length);
	for (const settler of owners) {
		if (error === null) settler.resolve();
		else settler.reject(error);
	}
}

export function trackSettler(settlers: OperationSettler[]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		settlers.push({ resolve, reject });
	});
}
