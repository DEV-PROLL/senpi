import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getSessionClaudeAccountPin } from "./account-command.ts";
import { AllAccountsBlockedError } from "./affinity.ts";
import { queryWithAuthLane } from "./auth-lane.ts";
import { buildCustomToolServers } from "./custom-tools.ts";
import { classifySdkError } from "./errors.ts";
import { defaultExecutableDeps, resolveClaudeCodeExecutable } from "./executable.ts";
import { allAccountsBlockedGuidance, sdkErrorGuidance } from "./guidance.ts";
import { buildClaudeAgentSdkQueryOptions } from "./options.ts";
import { buildPromptBlocks, buildPromptStream } from "./prompt-bridge.ts";
import { getSdkBoundary, type SdkQueryHandle } from "./sdk-boundary.ts";
import { loadClaudeAgentSdkProviderSettingsFromDisk } from "./settings.ts";
import {
	asRecord,
	emptyOutput,
	errorMessage,
	mapStopReason,
	mapToolArguments,
	type StreamBlock,
	type TextBlock,
	type ThinkingBlock,
	type ToolBlock,
	updateUsage,
} from "./stream-protocol.ts";
import { toolWatch } from "./tool-watch.ts";
import { mapSdkToolNameToPi, resolveSdkTools } from "./tools.ts";

export function streamClaudeAgentSdk(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = emptyOutput(model);
		const blocks: StreamBlock[] = [];
		let sdkQuery: SdkQueryHandle | undefined;
		let closed = false;
		let wasAborted = false;
		let started = false;
		let sawStreamEvent = false;
		let sawToolCall = false;
		let shouldStopEarly = false;
		const closeQuery = (): void => {
			if (closed || !sdkQuery) return;
			closed = true;
			sdkQuery.close();
		};
		const requestAbort = (): void => {
			if (!sdkQuery) return;
			void sdkQuery
				.interrupt()
				.catch(() => {})
				.finally(closeQuery);
		};
		const onAbort = (): void => {
			wasAborted = true;
			requestAbort();
		};
		if (options?.signal?.aborted) onAbort();
		else options?.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const resolvedTools = resolveSdkTools(context);
			const affinityKey = options?.affinitySessionId ?? options?.sessionId;
			const sessionKey = options?.sessionId ? toolWatch.sessionKey(options.sessionId) : undefined;
			if (sessionKey) toolWatch.reconcileWithContext(sessionKey, context);
			const toolWatchNote = toolWatch.buildPromptNote(sessionKey, context, resolvedTools.customToolNameToSdk);
			const providerSettings = loadClaudeAgentSdkProviderSettingsFromDisk(process.cwd());
			const mcpServers = buildCustomToolServers(resolvedTools.customTools);
			const executable = resolveClaudeCodeExecutable(defaultExecutableDeps());
			const messages = queryWithAuthLane({
				prompt: buildPromptStream(buildPromptBlocks(context, resolvedTools.customToolNameToSdk, toolWatchNote)),
				query: getSdkBoundary().query,
				providerSettings,
				sessionId: affinityKey,
				pinnedAccount: getSessionClaudeAccountPin(options?.sessionId),
				onQuery: (query) => {
					sdkQuery = query;
					if (wasAborted) requestAbort();
				},
				buildOptions: (authLane) => {
					const queryOptions = buildClaudeAgentSdkQueryOptions({
						model,
						context,
						streamOptions: options,
						providerSettings,
						authLane,
						tools: resolvedTools.sdkTools,
						pathToClaudeCodeExecutable: executable,
					});
					if (mcpServers) queryOptions.mcpServers = mcpServers;
					return queryOptions;
				},
			});

			for await (const message of messages) {
				if (!started) {
					stream.push({ type: "start", partial: output });
					started = true;
				}
				if (message.type === "stream_event") {
					sawStreamEvent = true;
					const event = message.event;
					if (event.type === "message_start") {
						updateUsage(model, output, event.message.usage);
					} else if (event.type === "content_block_start") {
						if (event.content_block.type === "text") {
							const block: TextBlock = { type: "text", text: "", index: event.index };
							blocks.push(block);
							output.content.push(block);
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "thinking") {
							const block: ThinkingBlock = {
								type: "thinking",
								thinking: "",
								thinkingSignature: "",
								index: event.index,
							};
							blocks.push(block);
							output.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "tool_use") {
							sawToolCall = true;
							const block: ToolBlock = {
								type: "toolCall",
								id: event.content_block.id,
								name: mapSdkToolNameToPi(event.content_block.name, resolvedTools.customToolNameToPi),
								arguments: asRecord(event.content_block.input),
								partialJson: "",
								index: event.index,
							};
							blocks.push(block);
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						}
					} else if (event.type === "content_block_delta") {
						const contentIndex = blocks.findIndex((block) => block.index === event.index);
						const block = blocks[contentIndex];
						if (event.delta.type === "text_delta" && block?.type === "text") {
							block.text += event.delta.text;
							stream.push({ type: "text_delta", contentIndex, delta: event.delta.text, partial: output });
						} else if (event.delta.type === "thinking_delta" && block?.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex,
								delta: event.delta.thinking,
								partial: output,
							});
						} else if (event.delta.type === "signature_delta" && block?.type === "thinking") {
							block.thinkingSignature += event.delta.signature;
						} else if (event.delta.type === "input_json_delta" && block?.type === "toolCall") {
							block.partialJson = `${block.partialJson ?? ""}${event.delta.partial_json}`;
							block.arguments = parseStreamingJson<Record<string, unknown>>(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.type === "content_block_stop") {
						const contentIndex = blocks.findIndex((block) => block.index === event.index);
						const block = blocks[contentIndex];
						if (block?.type === "text")
							stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
						else if (block?.type === "thinking")
							stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
						else if (block?.type === "toolCall") {
							block.arguments = mapToolArguments(
								block.name,
								parseStreamingJson<Record<string, unknown>>(block.partialJson),
							);
							delete block.partialJson;
							stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
						}
						if (block) delete block.index;
					} else if (event.type === "message_delta") {
						output.stopReason = mapStopReason(event.delta.stop_reason);
						updateUsage(model, output, event.usage);
					} else if (event.type === "message_stop" && sawToolCall) {
						output.stopReason = "toolUse";
						shouldStopEarly = true;
					}
				} else if (message.type === "result" && message.subtype === "success" && !sawStreamEvent) {
					output.content.push({ type: "text", text: message.result });
				} else if (message.type === "result" && message.subtype !== "success") {
					const reason =
						"errors" in message && Array.isArray(message.errors) && message.errors.length > 0
							? String(message.errors[0])
							: `Claude Code ${message.subtype}`;
					throw new Error(reason);
				}
				if (shouldStopEarly) break;
			}

			if (wasAborted || options?.signal?.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = "Operation aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
			} else {
				stream.push({
					type: "done",
					reason: output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop",
					message: output,
				});
			}
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = withAuthGuidance(error, errorMessage(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
			closeQuery();
			stream.end();
		}
	})();
	return stream;
}

function withAuthGuidance(error: unknown, message: string): string {
	if (error instanceof AllAccountsBlockedError) {
		return allAccountsBlockedGuidance(error.soonestUnblockAt);
	}
	const guidance = sdkErrorGuidance(classifySdkError(error).kind);
	return guidance ? `${message}\n${guidance}` : message;
}
