import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionContext,
	sanitizeTerminalLabel,
} from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import { isReservedToolName, runReservedTool } from "../bridges/reserved-dispatch.ts";
import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";
import { appendSchemaHint } from "../bridges/schema-hint.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { handleCompletionToolCall } from "../completion/tool-bridge.ts";
import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import { boundToolCallArgs, capCodePoints, MAX_ENRICHED_TOOL_CALLS, toolCallResultPreview } from "./call-capture.ts";
import {
	type EvalImageResizer,
	EvalOutputCollector,
	type EvalOutputResult,
	marshalToolResult,
	toolResultIsError,
} from "./image.ts";
import { upsertStatusEvent } from "./status-events.ts";
import type { EvalKernel, EvalStatusEvent, EvalToolDetails, EvalToolInput } from "./types.ts";

type ResolvedToolReply = {
	readonly value: unknown;
	readonly toolCallOk: boolean;
	readonly resultPreview?: string;
	readonly errorText?: string;
};

type ToolCallEnrichment = {
	readonly callId: string;
	readonly args: unknown;
	readonly startedAt: number;
	readonly argsTruncated?: true;
};

const LIVE_OUTPUT_PREVIEW_LINES = 8;

export interface CellState {
	readonly input: EvalToolInput;
	readonly signal: AbortSignal;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly toolCalls: EvalToolDetails["toolCalls"] extends readonly (infer Item)[] ? Item[] : never;
	readonly pendingBridgeCalls: Promise<void>[];
	readonly statusEvents: EvalStatusEvent[];
	active: boolean;
	output: string;
	phase: string | undefined;
	durationMs: number;
	status: "pending" | "running" | "complete" | "error";
}

export interface CellBridgeRuntime {
	readonly executeTool: AgentExecuteTool;
	readonly listTools?: () => readonly EvalSchemaToolInfo[];
	readonly settings: ResolvedCodemodeSettings;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly ctx: ExtensionContext;
	readonly artifactPath?: string;
	readonly imageResizer?: EvalImageResizer;
}

export class CellHandler {
	readonly #kernel: EvalKernel;
	readonly #state: CellState;
	readonly #runtime: CellBridgeRuntime;
	readonly #output: EvalOutputCollector;

	constructor(kernel: EvalKernel, state: CellState, runtime: CellBridgeRuntime) {
		this.#kernel = kernel;
		this.#state = state;
		this.#runtime = runtime;
		const settings = runtime.settings.outputSink;
		this.#output = new EvalOutputCollector({
			headBytes: settings.headBytes,
			maxColumns: settings.maxColumns,
			model: runtime.ctx.model,
			...(runtime.artifactPath === undefined ? {} : { artifactPath: runtime.artifactPath }),
			...(runtime.imageResizer === undefined ? {} : { imageResizer: runtime.imageResizer }),
			onChunk: (_aggregate, cell) => {
				state.output = cell;
				this.#emitUpdate(false);
			},
		});
		state.status = "running";
		this.#emitUpdate(false);
	}

	async handle(message: KernelToHostMessage): Promise<void> {
		if (!this.#state.active) return;
		switch (message.type) {
			case "text":
				this.#output.push(message.data);
				return;
			case "phase":
				this.#state.phase = message.title;
				this.#emitUpdate(false);
				return;
			case "status":
				this.#recordStatus(message.event);
				return;
			case "log":
				this.#output.push(`${message.message}\n`);
				return;
			case "display":
				this.#output.display(message);
				return;
			case "tool-call": {
				const pending = this.#handleToolCall(message);
				this.#state.pendingBridgeCalls.push(pending);
				await pending;
				return;
			}
			case "ready":
			case "init-failed":
			case "result":
			case "closed":
				return;
			default:
				throw new TypeError(`Unhandled kernel message: ${String(message)}`);
		}
	}

	async finalize(result: Extract<KernelToHostMessage, { type: "result" }>): Promise<AgentToolResult<EvalToolDetails>> {
		this.#state.durationMs = result.durationMs;
		if (result.ok) {
			if (result.valueRepr) this.#output.push(`${result.valueRepr}\n`);
			this.#state.status = "complete";
		} else {
			this.#output.push(`${result.error.message}\n`);
			this.#state.status = "error";
		}
		return await this.#finish(!result.ok);
	}

	async finalizeCancellation(error: Error): Promise<AgentToolResult<EvalToolDetails>> {
		this.#output.push(`${error.message}\n`);
		this.#state.status = "error";
		return await this.#finish(true);
	}

	async flushOutput(): Promise<void> {
		await this.#output.flush();
	}

	async #finish(isError: boolean): Promise<AgentToolResult<EvalToolDetails>> {
		const output = await this.#output.finish();
		this.#state.output = output.output;
		const details = this.#details(output, isError);
		this.#emitUpdate(isError);
		const text =
			output.output ||
			(output.images.length > 0
				? `(displayed ${output.images.length} image${output.images.length === 1 ? "" : "s"}; no text output)`
				: "(no output)");
		return { content: [{ type: "text", text }, ...output.images], details };
	}

	async #handleToolCall(message: Extract<KernelToHostMessage, { type: "tool-call" }>): Promise<void> {
		if (message.toolName === "eval") {
			const error = "recursive eval is not allowed";
			this.#state.toolCalls.push({ name: message.toolName, ok: false, error });
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: error },
			});
			return;
		}
		if (isReservedToolName(message.toolName)) {
			await this.#deliverToolReply(message, async () => ({
				value: await runReservedTool(message.toolName, {
					callId: message.callId,
					args: message.args,
					executeTool: this.#runtime.executeTool,
					taskToolName: this.#runtime.settings.taskTools.task,
					taskOutputToolName: this.#runtime.settings.taskTools.output,
					listTools: this.#runtime.listTools,
					signal: this.#state.signal,
					emitStatus: (event) => this.#recordStatus(event),
					marshalToolResult,
				}),
				toolCallOk: true,
			}));
			return;
		}
		if (message.toolName === "completion" && this.#runtime.complete) {
			const result = await handleCompletionToolCall({
				message,
				kernel: this.#kernel,
				complete: this.#runtime.complete,
				ctx: this.#runtime.ctx,
				isActive: () => this.#state.active,
			});
			if (!this.#state.active) return;
			this.#state.toolCalls.push(
				result.ok
					? { name: message.toolName, ok: true }
					: { name: message.toolName, ok: false, error: result.error },
			);
			this.#emitUpdate(false);
			return;
		}
		const capturedArgs = boundToolCallArgs(message.args);
		const startedAt = Date.now();
		await this.#deliverToolReply(
			message,
			async () => {
				const result = await this.#runtime.executeTool(message.toolName, message.args, {
					signal: this.#state.signal,
				});
				const toolCallOk = !toolResultIsError(result);
				if (toolCallOk) {
					const resultPreview = toolCallResultPreview(result);
					return {
						value: marshalToolResult(result),
						toolCallOk,
						...(resultPreview === undefined ? {} : { resultPreview }),
					};
				}
				let errorText: string | undefined;
				for (const part of result.content) {
					if (part.type !== "text") continue;
					errorText = capCodePoints(sanitizeTerminalLabel(part.text), 512);
					break;
				}
				return {
					value: marshalToolResult(result),
					toolCallOk,
					...(errorText === undefined ? {} : { errorText }),
				};
			},
			{
				callId: message.callId,
				args: capturedArgs.args,
				startedAt,
				...(capturedArgs.truncated ? { argsTruncated: true } : {}),
			},
		);
	}

	async #deliverToolReply(
		message: Extract<KernelToHostMessage, { type: "tool-call" }>,
		resolve: () => Promise<ResolvedToolReply>,
		enrich?: ToolCallEnrichment,
	): Promise<void> {
		try {
			const reply = await resolve();
			if (!this.#state.active) return;
			this.#pushToolCall(message.toolName, reply.toolCallOk, enrich, reply.resultPreview, reply.errorText);
			this.#kernel.deliverToolReply({ type: "tool-reply", callId: message.callId, ok: true, value: reply.value });
		} catch (error) {
			if (!this.#state.active) return;
			const text = appendSchemaHint(
				error instanceof Error ? error.message : String(error),
				message.toolName,
				this.#toolParameters(message.toolName),
			);
			this.#pushToolCall(message.toolName, false, enrich, undefined, text);
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: text },
			});
		}
		this.#emitUpdate(false);
	}

	#pushToolCall(
		name: string,
		ok: boolean,
		enrich: ToolCallEnrichment | undefined,
		resultPreview: string | undefined,
		error: string | undefined,
	): void {
		const summary = { name, ok, ...(error === undefined ? {} : { error }) };
		const enrichedCount = this.#state.toolCalls.filter((toolCall) => toolCall.callId !== undefined).length;
		if (enrich === undefined || enrichedCount >= MAX_ENRICHED_TOOL_CALLS) {
			this.#state.toolCalls.push(summary);
			return;
		}
		this.#state.toolCalls.push({
			...summary,
			callId: enrich.callId,
			args: enrich.args,
			durationMs: Date.now() - enrich.startedAt,
			...(enrich.argsTruncated === true ? { argsTruncated: true } : {}),
			...(resultPreview === undefined ? {} : { resultPreview }),
		});
	}

	#toolParameters(toolName: string): unknown {
		return this.#runtime.listTools?.().find((tool) => tool.name === toolName)?.parameters;
	}

	#recordStatus(event: EvalStatusEvent): void {
		if (!this.#runtime.settings.statusEvents) return;
		upsertStatusEvent(this.#state.statusEvents, event);
		this.#emitUpdate(false);
	}

	#details(output: EvalOutputResult | undefined, isError: boolean): EvalToolDetails {
		const statusEvents = this.#state.statusEvents.length > 0 ? [...this.#state.statusEvents] : undefined;
		return {
			language: this.#state.input.language,
			languages: [this.#state.input.language],
			...(this.#state.input.title === undefined ? {} : { title: this.#state.input.title }),
			durationMs: this.#state.durationMs,
			toolCalls: [...this.#state.toolCalls],
			truncated: output?.truncated ?? false,
			...(isError ? { isError: true } : {}),
			...(this.#state.phase === undefined ? {} : { phase: this.#state.phase }),
			cells: [
				{
					index: 0,
					...(this.#state.input.title === undefined ? {} : { title: this.#state.input.title }),
					code: this.#state.input.code,
					language: this.#state.input.language,
					output: this.#state.output,
					status: this.#state.status,
					durationMs: this.#state.durationMs,
					...(statusEvents === undefined ? {} : { statusEvents }),
					...(output?.hasMarkdown ? { hasMarkdown: true } : {}),
				},
			],
			...(statusEvents === undefined ? {} : { statusEvents }),
			...(output === undefined || output.jsonOutputs.length === 0 ? {} : { jsonOutputs: output.jsonOutputs }),
			...(output?.notice === undefined ? {} : { notice: output.notice }),
			...(output?.meta === undefined ? {} : { meta: output.meta }),
		};
	}

	#liveUpdateText(): string {
		const title = this.#state.input.title === undefined ? "" : ` ${this.#state.input.title}`;
		const aggregateOutput = this.#output.aggregateText();
		const outputLines = aggregateOutput.split("\n");
		const hasTrailingNewline = aggregateOutput.endsWith("\n");
		if (hasTrailingNewline) outputLines.pop();
		const output = `${outputLines.slice(-LIVE_OUTPUT_PREVIEW_LINES).join("\n")}${hasTrailingNewline ? "\n" : ""}`;
		return `1/1 cells ${this.#state.status}\n[1] ${this.#state.input.language}${title} ${this.#state.status}${output.length === 0 ? "" : `\n${output}`}`;
	}

	#emitUpdate(isError: boolean): void {
		if (!this.#state.active) return;
		this.#state.onUpdate?.({
			content: [{ type: "text", text: this.#liveUpdateText() }],
			details: this.#details(undefined, isError),
		});
	}
}
