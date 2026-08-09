/**
 * Resumption-channel liveness contract shared with the goal builtin.
 *
 * The goal builtin delays its hidden continuation while any live resumption
 * channel can still wake the session. Each emitter publishes a full per-source
 * snapshot on every liveness transition and once on `session_start`.
 *
 * The event name is duplicated here on purpose: senpi-codemode is a separate
 * package and must not import across the packages/coding-agent boundary, so
 * the sentinel test pins this literal to the exact cross-package contract.
 */
export const RESUMPTION_CHANNEL_STATE_EVENT = "resumption_channel_state";

/** Source key identifying detached eval cells in the per-source snapshot. */
export const EVAL_DETACHED_CHANNEL_SOURCE = "eval-detached";

/** One live channel as broadcast on the resumption channel state event. */
export interface ResumptionChannelEntry {
	readonly id: string;
	readonly description: string;
	/** Epoch milliseconds when the channel registered; lets consumers render their own elapsed labels. */
	readonly startedAtMs: number;
}

export interface ResumptionChannelState {
	readonly source: string;
	readonly activeCount: number;
	readonly channels?: readonly ResumptionChannelEntry[];
}
