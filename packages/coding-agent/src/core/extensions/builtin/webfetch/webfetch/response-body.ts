export interface ResponseBodyStream extends AsyncIterable<unknown> {
	on?(event: "error", listener: (error: Error) => void): unknown;
	destroy(error?: Error): void;
	dump?(options?: { limit: number; signal?: AbortSignal }): Promise<void>;
}

export async function discardBody(body: ResponseBodyStream, maxBytes: number): Promise<void> {
	try {
		if (typeof body.dump === "function") {
			await body.dump({ limit: 1024 });
			return;
		}
		await drainBody(body, maxBytes);
	} catch {
		// Discard failures are not actionable for the caller.
	} finally {
		body.on?.("error", () => {});
		body.destroy();
	}
}

async function drainBody(body: ResponseBodyStream, maxBytes: number): Promise<void> {
	let drained = 0;
	for await (const chunk of body) {
		drained += toUint8Array(chunk).length;
		if (drained > maxBytes) return;
	}
}

export function toUint8Array(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	if (typeof chunk === "string") return new TextEncoder().encode(chunk);
	throw new Error("Unexpected response body chunk");
}
