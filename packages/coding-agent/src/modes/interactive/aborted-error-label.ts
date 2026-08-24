import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";

const PERSISTED_SOURCE_LABELS = new Set(["Operation aborted", "System operation aborted"]);

export function abortedErrorLabel(
	persisted: string | undefined,
	retryAttempt: number,
	abortSource: AgentAbortSource | undefined,
): string {
	if (abortSource === "user") return "Operation aborted";
	if (abortSource === "system") return "System operation aborted";
	if (persisted !== undefined && PERSISTED_SOURCE_LABELS.has(persisted)) return persisted;
	const legacyRetry = persisted?.match(/^Aborted after (\d+) retry attempts?$/);
	if (legacyRetry) return `Provider retry failed after ${legacyRetry[1]} attempt${legacyRetry[1] === "1" ? "" : "s"}`;
	if (retryAttempt > 0) return `Provider retry failed after ${retryAttempt} attempt${retryAttempt === 1 ? "" : "s"}`;
	if (persisted !== undefined && persisted !== "Request was aborted") return `Provider request failed: ${persisted}`;
	return "Provider request failed";
}
