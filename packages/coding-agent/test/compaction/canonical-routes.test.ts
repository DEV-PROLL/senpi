import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertResponsesMessages } from "../../../ai/src/api/openai-responses-shared.ts";
import { type CompactionResult, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import {
	buildOpenAiRemoteCompactionResult,
	rewriteOpenAiPayloadWithRemoteCompaction,
} from "../../src/core/extensions/builtin/compaction/openai-remote.ts";
import type { BeforeAgentStartEvent } from "../../src/core/extensions/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import {
	type SessionEntry,
	type SessionMessageEntry,
	sessionEntryToContextMessages,
} from "../../src/core/session-manager.ts";
import { createHarness } from "../suite/harness.ts";

const OPENAI_MODEL = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "http://openai.test/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_024,
} satisfies Model<"openai-responses">;

afterEach(() => {
	vi.unstubAllGlobals();
});

function messageEntry(id: string, parentId: string | null, message: SessionMessageEntry["message"]): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(1_775_000_000_000 + id.length).toISOString(),
		message,
	};
}

function openAiBranch(): SessionEntry[] {
	const assistant = {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: OPENAI_MODEL.id,
		content: [{ type: "text", text: "I inspected the build. ".repeat(1_000) }],
		usage: {
			input: 200,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 220,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	} satisfies AssistantMessage;

	return [
		{
			type: "model_change",
			id: "model",
			parentId: null,
			timestamp: new Date(1_775_000_000_000).toISOString(),
			provider: "openai",
			modelId: OPENAI_MODEL.id,
		},
		messageEntry("u1", "model", {
			role: "user",
			content: [{ type: "text", text: "Please inspect the build. ".repeat(1_000) }],
			timestamp: 1,
		}),
		messageEntry("a1", "u1", assistant),
		messageEntry("u2", "a1", {
			role: "user",
			content: [{ type: "text", text: "Continue after compaction." }],
			timestamp: 3,
		}),
	];
}

async function loadBeforeAgentStartHandler(): Promise<
	(event: BeforeAgentStartEvent, ctx: unknown) => Promise<unknown>
> {
	const extension = await loadExtensionFromFactory(
		compactionExtension,
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<builtin:compaction>",
	);
	const handler = extension.handlers.get("before_agent_start")?.[0];
	if (!handler) {
		throw new Error("builtin compaction before_agent_start handler was not registered");
	}
	return async (event, ctx) => await handler(event, ctx);
}

describe("builtin compaction canonical routes", () => {
	it("uses OpenAI remote compaction before provider submission when the pending prompt would exceed the hard limit", async () => {
		const branchEntries = openAiBranch();
		const appliedCompactions: CompactionResult[] = [];
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					id: "resp_compact",
					object: "response.compaction",
					created_at: 1_775_000_001,
					output: [{ type: "context_compaction", encrypted_content: "encrypted-summary" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const handler = await loadBeforeAgentStartHandler();
		await handler(
			{
				type: "before_agent_start",
				prompt: "incoming prompt ".repeat(1_500),
				systemPrompt: "You are senpi.",
				systemPromptOptions: { cwd: process.cwd() },
			},
			{
				model: OPENAI_MODEL,
				serviceTier: undefined,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
				},
				sessionManager: {
					getBranch: () => branchEntries,
					getEntries: () => branchEntries,
					getSessionId: () => "session-1",
				},
				getContextUsage: () => ({ tokens: 3_000, contextWindow: 10_000, percent: 30 }),
				getCompactionSettings: () => ({
					...DEFAULT_COMPACTION_SETTINGS,
					keepRecentTokens: 200,
					reserveTokens: 2_000,
				}),
				getMessageRevision: () => 1,
				getSystemPrompt: () => "You are senpi.",
				beginCompaction: () => new AbortController().signal,
				endCompaction: () => {},
				applyCompaction: async (compaction: CompactionResult) => {
					appliedCompactions.push(compaction);
					return { applied: true as const, reason: "ok" as const };
				},
				ui: { notify: () => {} },
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(appliedCompactions).toHaveLength(1);
		expect(appliedCompactions[0]?.details).toMatchObject({
			schema: "senpi.compaction.openai-remote.v1",
			mode: "openai-remote",
			transport: "compact-endpoint",
		});
	});

	it("retains the current prompt after a checkpoint prefix whose failed turns Responses drops", () => {
		const currentPrompt = "CURRENT_PROMPT_MUST_APPEAR_ONCE";
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const branch: SessionEntry[] = [
			messageEntry("u1", null, {
				role: "user",
				content: [{ type: "text", text: "kept checkpoint context" }],
				timestamp: 1,
			}),
			messageEntry("error", "u1", {
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: OPENAI_MODEL.id,
				content: [
					{ type: "text", text: "ERRORED_ASSISTANT_SHOULD_NOT_REPLAY" },
					{ type: "toolCall", id: "call_error|fc_error", name: "read", arguments: {} },
				],
				usage,
				stopReason: "error",
				timestamp: 2,
			}),
			messageEntry("error-result", "error", {
				role: "toolResult",
				toolCallId: "call_error|fc_error",
				toolName: "read",
				content: [{ type: "text", text: "ERRORED_TOOL_RESULT_SHOULD_NOT_REPLAY" }],
				isError: true,
				timestamp: 3,
			}),
			messageEntry("aborted", "error-result", {
				role: "assistant",
				api: "openai-responses",
				provider: "openai",
				model: OPENAI_MODEL.id,
				content: [
					{ type: "text", text: "ABORTED_ASSISTANT_SHOULD_NOT_REPLAY" },
					{ type: "toolCall", id: "call_abort|fc_abort", name: "read", arguments: {} },
				],
				usage,
				stopReason: "aborted",
				timestamp: 4,
			}),
			messageEntry("aborted-result", "aborted", {
				role: "toolResult",
				toolCallId: "call_abort|fc_abort",
				toolName: "read",
				content: [{ type: "text", text: "ABORTED_TOOL_RESULT_SHOULD_NOT_REPLAY" }],
				isError: true,
				timestamp: 5,
			}),
			messageEntry("empty", "aborted-result", {
				role: "user",
				content: [],
				timestamp: 6,
			}),
			{
				type: "compaction",
				id: "checkpoint",
				parentId: "empty",
				timestamp: new Date(1_775_000_001_000).toISOString(),
				summary: "fallback checkpoint summary",
				firstKeptEntryId: "u1",
				tokensBefore: 100,
				fromHook: true,
				details: {
					schema: "senpi.compaction.openai-remote.v1",
					mode: "openai-remote",
					provider: "openai",
					api: "openai-responses",
					transport: "compact-endpoint",
					modelId: OPENAI_MODEL.id,
					responseId: "checkpoint-response",
					createdAt: 1_775_000_001,
					requestInputItemCount: 1,
					retainedInputItemCount: 1,
					replacementInput: [{ type: "compaction", encrypted_content: "provider-checkpoint" }],
				},
			},
		];

		const checkpointIndex = branch.findIndex((entry) => entry.id === "checkpoint");
		const canonicalInput = convertResponsesMessages(
			OPENAI_MODEL,
			{
				systemPrompt: "current system prompt",
				messages: [
					...convertToLlm(
						[branch[checkpointIndex]!, ...branch.slice(0, checkpointIndex)].flatMap(
							sessionEntryToContextMessages,
						),
					),
					{ role: "user", content: [{ type: "text", text: currentPrompt }], timestamp: 7 },
				],
			},
			new Set(["openai"]),
		);
		const canonicalPayload = JSON.stringify(canonicalInput);
		expect(canonicalPayload).not.toContain("ERRORED_ASSISTANT_SHOULD_NOT_REPLAY");
		expect(canonicalPayload).not.toContain("ERRORED_TOOL_RESULT_SHOULD_NOT_REPLAY");
		expect(canonicalPayload).not.toContain("ABORTED_ASSISTANT_SHOULD_NOT_REPLAY");
		expect(canonicalPayload).not.toContain("ABORTED_TOOL_RESULT_SHOULD_NOT_REPLAY");

		const rewritten = rewriteOpenAiPayloadWithRemoteCompaction(
			{ model: OPENAI_MODEL.id, input: canonicalInput, stream: true },
			{ model: OPENAI_MODEL, branchEntries: branch },
		);
		const rewrittenPayload = JSON.stringify(rewritten);

		// The boundary must come from the actual provider payload, not a second
		// converter that counts the empty user and dropped tool pairs above.
		expect(rewrittenPayload.split(currentPrompt)).toHaveLength(2);
		expect(rewrittenPayload).toContain("provider-checkpoint");
	});

	it("replays a remote checkpoint from the final redacted context without mutating persisted messages", async () => {
		const sensitivePostCompaction = "SENSITIVE_POST_COMPACTION_CONTEXT";
		const sensitiveCurrentPrompt = "SENSITIVE_CURRENT_PROMPT";
		const redactedPostCompaction = "[redacted post-compaction context]";
		const redactedCurrentPrompt = "[redacted current prompt]";
		const contextHookOrder: string[] = [];
		let firstContextHookInput = "";
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [
				{ id: OPENAI_MODEL.id, contextWindow: OPENAI_MODEL.contextWindow, maxTokens: OPENAI_MODEL.maxTokens },
			],
			extensionFactories: [
				compactionExtension,
				(pi) => {
					pi.on("context", (event) => {
						contextHookOrder.push("first");
						firstContextHookInput = JSON.stringify(event.messages);
						return { messages: event.messages };
					});
				},
				(pi) => {
					pi.on("context", (event) => {
						contextHookOrder.push("redact");
						return {
							messages: event.messages.map((message) => {
								if (message.role !== "user" || typeof message.content === "string") return message;
								return {
									...message,
									content: message.content.map((part) =>
										part.type !== "text"
											? part
											: {
													...part,
													text: part.text
														.replaceAll(sensitivePostCompaction, redactedPostCompaction)
														.replaceAll(sensitiveCurrentPrompt, redactedCurrentPrompt),
												},
									),
								};
							}),
						};
					});
				},
			],
		});

		try {
			const model = harness.getModel() as Model<"openai-responses">;
			const retainedEntryId = harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "retained checkpoint context" }],
				timestamp: 1,
			});
			const checkpoint = buildOpenAiRemoteCompactionResult({
				model,
				firstKeptEntryId: retainedEntryId,
				tokensBefore: 1_234,
				requestInputItemCount: 1,
				response: {
					id: "resp_checkpoint",
					created_at: 1_775_000_001,
					object: "response.compaction",
					output: [{ type: "compaction", id: "cmp_checkpoint", encrypted_content: "encrypted-checkpoint" }],
				},
			});
			harness.sessionManager.appendCompaction(
				checkpoint.summary,
				checkpoint.firstKeptEntryId,
				checkpoint.tokensBefore,
				checkpoint.details,
				true,
			);
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `post-checkpoint: ${sensitivePostCompaction}` }],
				timestamp: 2,
			});

			const persistedBeforeTransform = JSON.stringify(harness.sessionManager.getBranch());
			const transformedContext = await harness.getExtensionRunner().emitContext([
				...harness.sessionManager.buildSessionContext().messages,
				{
					role: "user",
					content: [{ type: "text", text: `current prompt: ${sensitiveCurrentPrompt}` }],
					timestamp: 3,
				},
			]);
			const transformedContextText = JSON.stringify(transformedContext);
			expect(contextHookOrder).toEqual(["first", "redact"]);
			expect(firstContextHookInput).toContain(sensitivePostCompaction);
			expect(firstContextHookInput).toContain(sensitiveCurrentPrompt);
			expect(transformedContextText).toContain(redactedPostCompaction);
			expect(transformedContextText).toContain(redactedCurrentPrompt);
			expect(transformedContextText).not.toContain(sensitivePostCompaction);
			expect(transformedContextText).not.toContain(sensitiveCurrentPrompt);
			expect(JSON.stringify(harness.sessionManager.getBranch())).toBe(persistedBeforeTransform);
			expect(persistedBeforeTransform).toContain(sensitivePostCompaction);
			const finalProviderInput = transformedContext.flatMap((message) => {
				if (message.role !== "user") return [];
				return [
					{
						role: "user" as const,
						content:
							typeof message.content === "string"
								? [{ type: "input_text" as const, text: message.content }]
								: message.content.flatMap((part) =>
										part.type === "text" ? [{ type: "input_text" as const, text: part.text }] : [],
									),
					},
				];
			});

			const rewritten = await harness.getExtensionRunner().emitBeforeProviderRequest({
				model: model.id,
				input: [{ role: "developer", content: "current system prompt" }, ...finalProviderInput],
				stream: true,
			});
			const outgoingRemoteInput = JSON.stringify(rewritten);
			expect(outgoingRemoteInput).toContain(redactedPostCompaction);
			expect(outgoingRemoteInput).toContain(redactedCurrentPrompt);
			expect(outgoingRemoteInput).not.toContain(sensitivePostCompaction);
			expect(outgoingRemoteInput).not.toContain(sensitiveCurrentPrompt);
		} finally {
			harness.cleanup();
		}
	});
});
