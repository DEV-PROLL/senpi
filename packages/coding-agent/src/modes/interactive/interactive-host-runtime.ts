import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import { executeBashWithOperations } from "../../core/bash-executor.ts";
import type { ProjectTrustContext, ReplacedSessionContext } from "../../core/extensions/index.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { BashOperations } from "../../core/tools/bash.ts";
import { type EnsuredHost, ensureHost } from "../rpc/host-ensure.ts";
import { RpcClient, type RpcClientEvent } from "../rpc/rpc-client.ts";

export const INTERACTIVE_HOST_FALLBACK_WARNING = "Warning: shared interactive host unavailable; continuing locally";

export interface InteractiveHostWarning {
	readonly type: "interactive_host_fallback" | "interactive_host_action_failed";
	readonly message: string;
	readonly cause: unknown;
}

/**
 * The session contract InteractiveMode actually runs against. The local
 * AgentSession answers these reads synchronously; the shared-host proxy answers
 * them over RPC. Declaring the union here keeps the proxy honest (no more
 * `as unknown as` lie at the boundary) and lets the compiler find every TUI
 * call site that must await.
 */
export type InteractiveSession = Omit<
	AgentSession,
	"cycleThinkingLevel" | "getAvailableThinkingLevels" | "getSessionStats" | "getUserMessagesForForking"
> & {
	cycleThinkingLevel(): ThinkingLevel | undefined | Promise<ThinkingLevel | undefined>;
	getAvailableThinkingLevels(): ThinkingLevel[] | Promise<ThinkingLevel[]>;
	getSessionStats():
		| ReturnType<AgentSession["getSessionStats"]>
		| Promise<ReturnType<AgentSession["getSessionStats"]>>;
	getUserMessagesForForking():
		| ReturnType<AgentSession["getUserMessagesForForking"]>
		| Promise<ReturnType<AgentSession["getUserMessagesForForking"]>>;
};

export type InteractiveHostUiHandler = (
	request: import("../rpc/rpc-types.ts").RpcExtensionUIRequest,
) =>
	| Promise<import("../rpc/rpc-types.ts").RpcExtensionUIResponse | undefined>
	| import("../rpc/rpc-types.ts").RpcExtensionUIResponse
	| undefined;

export interface InteractiveHostRuntimeOptions {
	readonly socket: string;
	readonly agentDir?: string;
	readonly ensureHost?: (options: { socket: string; agentDir?: string }) => Promise<EnsuredHost | undefined>;
	onWarning?: (warning: InteractiveHostWarning) => void;
}

/**
 * Replace only the transport-facing session operations. The object returned is
 * deliberately still an AgentSessionRuntime: InteractiveMode and extensions
 * retain their existing runtime seam, while the authoritative prompt/session
 * state is hosted by the shared RPC process.
 */
export async function createInteractiveHostRuntime(
	localRuntime: AgentSessionRuntime,
	options: InteractiveHostRuntimeOptions,
): Promise<AgentSessionRuntime> {
	const sessionPath = localRuntime.session.sessionFile;
	if (!sessionPath) return localRuntime;
	const startHost = options.ensureHost ?? ((hostOptions) => ensureHost(hostOptions));
	const client = new RpcClient({ socketPath: options.socket });
	try {
		await startHost({ socket: options.socket, agentDir: options.agentDir });
		await client.start();
		const opened = await client.openSession({
			sessionPath,
			cwd: localRuntime.cwd,
			provider: localRuntime.session.model?.provider,
			modelId: localRuntime.session.model?.id,
			thinkingLevel: localRuntime.session.thinkingLevel,
		});
		const remoteSession = createRemoteSessionProxy(
			localRuntime.session,
			localRuntime.services.agentDir,
			client,
			opened.state,
			options.onWarning,
		);
		return new RemoteInteractiveRuntime(localRuntime, remoteSession, client) as unknown as AgentSessionRuntime;
	} catch (cause) {
		await client.stop().catch(() => {});
		options.onWarning?.({
			type: "interactive_host_fallback",
			message: `${INTERACTIVE_HOST_FALLBACK_WARNING}: ${cause instanceof Error ? cause.message : String(cause)}`,
			cause,
		});
		return localRuntime;
	}
}

export class RemoteInteractiveRuntime {
	readonly #local: AgentSessionRuntime;
	readonly #remoteSession: RemoteSessionProxy;
	readonly #client: RpcClient;
	#rebindSession: (() => Promise<void>) | undefined;
	#beforeSessionInvalidate: (() => void) | undefined;

	constructor(local: AgentSessionRuntime, remoteSession: RemoteSessionProxy, client: RpcClient) {
		this.#local = local;
		this.#remoteSession = remoteSession;
		this.#client = client;
	}

	get session(): AgentSession {
		return this.#remoteSession.session;
	}
	get services(): AgentSessionRuntime["services"] {
		return this.#local.services;
	}
	get cwd(): string {
		return this.#remoteSession.session.sessionManager.getCwd();
	}
	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this.#local.diagnostics;
	}
	get modelFallbackMessage(): string | undefined {
		return this.#local.modelFallbackMessage;
	}
	get launchProfile(): AgentSessionRuntime["launchProfile"] {
		return this.#local.launchProfile;
	}
	setBeforeSessionInvalidate(callback?: () => void): void {
		this.#beforeSessionInvalidate = callback;
	}
	setRebindSession(callback?: () => Promise<void>): void {
		this.#rebindSession = callback;
	}
	setHostUiHandler(callback?: InteractiveHostUiHandler): void {
		this.#remoteSession.setHostUiHandler(callback);
	}
	async dispose(): Promise<void> {
		const errors: unknown[] = [];
		for (const cleanup of [
			() => this.#client.closeSession(),
			() => this.#client.stop(),
			() => this.#local.dispose(),
		]) {
			try {
				await cleanup();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw errors[0];
	}
	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const result = await this.#client.newSession(options?.parentSession);
		if (!result.cancelled) {
			this.#beforeSessionInvalidate?.();
			this.#remoteSession.abortLocalBash();
			await this.#remoteSession.refresh();
			if (options?.setup) {
				const capture = SessionManager.inMemory(this.#remoteSession.session.sessionManager.getCwd());
				await options.setup(capture);
				for (const entry of capture.getEntries()) await this.#client.appendSessionEntry(entry);
				await this.#remoteSession.refresh();
			}
			await this.#rebindSession?.();
			if (options?.withSession) await options.withSession(this.#remoteSession.createReplacedSessionContext());
		}
		return result;
	}
	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const result = await this.#client.switchSession(sessionPath, options);
		if (!result.cancelled) {
			this.#beforeSessionInvalidate?.();
			this.#remoteSession.abortLocalBash();
			await this.#remoteSession.refresh();
			await this.#rebindSession?.();
			// The shared host already resolved trust; this callback is retained for
			// compatibility, but its result cannot override host-authoritative state.
			options?.projectTrustContextFactory?.(this.#remoteSession.session.sessionManager.getCwd());
			if (options?.withSession) await options.withSession(this.#remoteSession.createReplacedSessionContext());
		}
		return result;
	}
	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const result = await this.#client.fork(entryId, options);
		if (!result.cancelled) {
			this.#beforeSessionInvalidate?.();
			this.#remoteSession.abortLocalBash();
			await this.#refreshAndRebind();
			if (options?.withSession) await options.withSession(this.#remoteSession.createReplacedSessionContext());
		}
		return { cancelled: result.cancelled, selectedText: result.text };
	}
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const result = await this.#client.importJsonl(inputPath, cwdOverride);
		if (!result.cancelled) {
			this.#beforeSessionInvalidate?.();
			this.#remoteSession.abortLocalBash();
			await this.#refreshAndRebind();
		}
		return result;
	}

	async #refreshAndRebind(): Promise<void> {
		await this.#remoteSession.refresh();
		await this.#rebindSession?.();
	}
}

interface RemoteSessionProxy {
	readonly session: AgentSession;
	setHostUiHandler(callback?: InteractiveHostUiHandler): void;
	refresh(): Promise<void>;
	abortLocalBash(): void;
	createReplacedSessionContext(): ReplacedSessionContext;
}

function createRemoteSessionProxy(
	local: AgentSession,
	agentDir: string,
	client: RpcClient,
	initialState: ReturnType<typeof stateFromRpc>,
	onWarning?: (warning: InteractiveHostWarning) => void,
): RemoteSessionProxy {
	// Fire-and-forget setters keep the sync AgentSession signature, but their RPC
	// failures must not vanish: the matching *_changed wire event confirms success,
	// and a rejection here is the only signal of failure.
	const reportActionFailure = (action: string) => (error: unknown) => {
		onWarning?.({
			type: "interactive_host_action_failed",
			message: `Warning: shared interactive host ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
			cause: error,
		});
	};
	let state = { ...initialState };
	let bashChunk: ((chunk: string) => void) | undefined;
	let hostUiHandler: InteractiveHostUiHandler | undefined;
	const pendingUiRequests: import("../rpc/rpc-types.ts").RpcExtensionUIRequest[] = [];
	let localBashAbortController: AbortController | undefined;
	let localBashRunning = false;
	let hostBashRunning = initialState.isBashRunning;
	let sessionManager = local.sessionManager;
	let settingsManager = SettingsManager.create(initialState.cwd, agentDir, {
		projectTrusted: initialState.projectTrusted,
	});
	const updateBashState = () => {
		state = { ...state, isBashRunning: localBashRunning || hostBashRunning };
	};
	const remoteSessionManager = new Proxy({} as SessionManager, {
		get(_target, property, _receiver) {
			if (property === "appendLabelChange") {
				return (entryId: string, label?: string) => void client.setLabel(entryId, label);
			}
			if (property === "getCwd") return () => state.cwd;
			if (property === "getSessionName") return () => state.sessionName;
			if (property === "getUsageTotals") return () => state.usageTotals;
			const value = Reflect.get(sessionManager, property, sessionManager);
			return typeof value === "function" ? value.bind(sessionManager) : value;
		},
	});
	let streamingAssistant: Extract<AgentSession["messages"][number], { role: "assistant" }> | undefined;
	let mirroredCurrentAssistantUsage = false;
	const listeners = new Set<AgentSessionEventListener>();
	client.onEvent((wireEvent) => {
		if ((wireEvent as { type?: string }).type === "extension_ui_request") {
			const request = wireEvent as import("../rpc/rpc-types.ts").RpcExtensionUIRequest;
			if (hostUiHandler)
				void Promise.resolve(hostUiHandler(request)).then(
					(response) => response && client.sendExtensionUIResponse(response),
				);
			else pendingUiRequests.push(request);
			return;
		}
		if (wireEvent.type === "agent_settled") state = { ...state, isStreaming: false, retryAttempt: 0 };
		if (wireEvent.type === "bash_start") {
			hostBashRunning = true;
			updateBashState();
		}
		if (wireEvent.type === "bash_end") {
			hostBashRunning = false;
			updateBashState();
		}
		if (wireEvent.type === "bash_execution_update") bashChunk?.(wireEvent.delta);
		if (wireEvent.type === "agent_start") state = { ...state, isStreaming: true };
		if (wireEvent.type === "compaction_start") state = { ...state, isCompacting: true };
		if (wireEvent.type === "compaction_end") state = { ...state, isCompacting: false };
		if (wireEvent.type === "auto_retry_start") state = { ...state, retryAttempt: wireEvent.attempt };
		if (wireEvent.type === "auto_retry_end") state = { ...state, retryAttempt: 0 };
		if (wireEvent.type === "queue_update") {
			state = {
				...state,
				steering: [...wireEvent.steering],
				followUp: [...wireEvent.followUp],
				ordered: [...wireEvent.ordered],
				pendingMessageCount: wireEvent.steering.length + wireEvent.followUp.length,
			};
		}
		if (wireEvent.type === "model_changed") {
			state = { ...state, model: wireEvent.model, thinkingLevel: wireEvent.thinkingLevel };
		}
		if (wireEvent.type === "thinking_level_changed") state = { ...state, thinkingLevel: wireEvent.level };
		if (wireEvent.type === "service_tier_changed") {
			state = { ...state, serviceTier: wireEvent.tier, fastMode: wireEvent.fastMode };
		}
		if (wireEvent.type === "session_info_changed") state = { ...state, sessionName: wireEvent.name };
		if (wireEvent.type === "message_start") {
			if (wireEvent.message.role === "assistant") {
				streamingAssistant = structuredClone(wireEvent.message);
				mirroredCurrentAssistantUsage = false;
			}
			local.agent.state.messages.push(structuredClone(wireEvent.message));
		}
		if (wireEvent.type === "message_end") {
			if (wireEvent.message.role === "assistant") {
				streamingAssistant = structuredClone(wireEvent.message);
				const usage = wireEvent.message.usage;
				if (usage && !mirroredCurrentAssistantUsage) {
					mirroredCurrentAssistantUsage = true;
					const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
					const contextWindow = state.model?.contextWindow ?? 0;
					const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
					state = {
						...state,
						contextUsage:
							contextWindow > 0
								? { tokens: contextTokens, contextWindow, percent: (contextTokens / contextWindow) * 100 }
								: undefined,
						usageTotals: {
							...state.usageTotals,
							input: state.usageTotals.input + usage.input,
							output: state.usageTotals.output + usage.output,
							cacheRead: state.usageTotals.cacheRead + usage.cacheRead,
							cacheWrite: state.usageTotals.cacheWrite + usage.cacheWrite,
							cost: state.usageTotals.cost + (usage.cost?.total ?? 0),
							latestCacheHitRate:
								latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined,
						},
					};
				}
			}
			const messages = local.agent.state.messages;
			const previous = messages.at(-1);
			if (previous?.role === wireEvent.message.role)
				messages[messages.length - 1] = structuredClone(wireEvent.message);
		}
		if (wireEvent.type === "compaction_end" && wireEvent.accepted && !wireEvent.aborted) {
			try {
				sessionManager.reloadFromDisk?.();
				local.agent.state.messages = sessionManager.buildSessionContext().messages;
			} catch {
				// Non-fatal if session file is transiently locked or unavailable
			}
		}
		const event = hydrateMessageUpdate(wireEvent, streamingAssistant);
		for (const listener of listeners) listener(event);
	});
	const refresh = async (): Promise<void> => {
		const nextState = await client.getState();
		state = { ...stateFromRpc(nextState) };
		let messages: AgentSession["messages"];
		settingsManager = SettingsManager.create(nextState.cwd, agentDir, {
			projectTrusted: nextState.projectTrusted,
		});
		if (nextState.sessionFile) {
			// SessionManager.open retains the explicit path even when the host has
			// deferred creating the file for a setup-only session.
			sessionManager = SessionManager.open(nextState.sessionFile, undefined, nextState.cwd);
			if (nextState.entries?.length && !sessionManager.getEntries().length) {
				for (const entry of nextState.entries) sessionManager.appendEntry(entry);
			}
			messages = sessionManager.buildSessionContext().messages;
		} else {
			messages = await client.getMessages();
		}
		local.agent.state.messages.splice(0, local.agent.state.messages.length, ...structuredClone(messages));
		streamingAssistant = undefined;
	};
	const session = new Proxy(local, {
		get(target, property, receiver) {
			if (property === "prompt")
				return (message: string, options?: Parameters<AgentSession["prompt"]>[1]) =>
					client.prompt(message, {
						...(options?.images ? { images: options.images } : {}),
						...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
						...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
						...(options?.promptDisposition ? { promptDisposition: options.promptDisposition } : {}),
						...(options?.preflightResult ? { preflightResult: options.preflightResult } : {}),
					});
			if (property === "abort") return () => client.abort();
			if (property === "abortCompaction") return () => void client.abortCompaction();
			if (property === "steer")
				return (
					message: string,
					images?: Parameters<AgentSession["steer"]>[1],
					recovery?: { enqueueOrder?: number },
				) => {
					const enqueueOrder =
						recovery?.enqueueOrder ?? Math.max(0, ...state.ordered.map((item) => item.enqueueOrder)) + 1;
					state = {
						...state,
						steering: [...state.steering, message],
						ordered: [...state.ordered, { text: message, mode: "steer", enqueueOrder }],
						pendingMessageCount: state.pendingMessageCount + 1,
					};
					return client.steer(message, images, { ...recovery, enqueueOrder });
				};
			if (property === "followUp")
				return (
					message: string,
					images?: Parameters<AgentSession["followUp"]>[1],
					recovery?: { enqueueOrder?: number },
				) => {
					const enqueueOrder =
						recovery?.enqueueOrder ?? Math.max(0, ...state.ordered.map((item) => item.enqueueOrder)) + 1;
					state = {
						...state,
						followUp: [...state.followUp, message],
						ordered: [...state.ordered, { text: message, mode: "followUp", enqueueOrder }],
						pendingMessageCount: state.pendingMessageCount + 1,
					};
					return client.followUp(message, images, { ...recovery, enqueueOrder });
				};
			if (property === "waitForIdle") return () => client.waitForIdle();
			if (property === "getLastAssistantText") return () => target.getLastAssistantText();
			if (property === "setModel")
				return async (model: NonNullable<AgentSession["model"]>) => {
					const next = await client.setModel(model.provider, model.id);
					return { systemPromptName: next.systemPromptName, model: next };
				};
			if (property === "cycleModel") return () => client.cycleModel();
			if (property === "setThinkingLevel")
				return (level: AgentSession["thinkingLevel"]) =>
					void client.setThinkingLevel(level).catch(reportActionFailure("setThinkingLevel"));
			if (property === "cycleThinkingLevel")
				return () => client.cycleThinkingLevel().then((result) => result?.level);
			if (property === "getAvailableThinkingLevels") return () => client.getAvailableThinkingLevels();
			if (property === "setSteeringMode")
				return (mode: AgentSession["steeringMode"]) =>
					void client.setSteeringMode(mode).catch(reportActionFailure("setSteeringMode"));
			if (property === "setFollowUpMode")
				return (mode: AgentSession["followUpMode"]) =>
					void client.setFollowUpMode(mode).catch(reportActionFailure("setFollowUpMode"));
			if (property === "compact") return (instructions?: string) => client.compact(instructions);
			if (property === "setAutoCompactionEnabled")
				return (enabled: boolean) =>
					void client.setAutoCompaction(enabled).catch(reportActionFailure("setAutoCompaction"));
			if (property === "executeBash")
				return async (
					command: string,
					onChunk?: (chunk: string) => void,
					options?: { excludeFromContext?: boolean; operations?: BashOperations | Record<string, unknown> },
				) => {
					if (options?.operations && typeof options.operations.exec === "function") {
						const abortController = new AbortController();
						localBashAbortController = abortController;
						localBashRunning = true;
						updateBashState();
						const sessionAtStart = state.sessionId;
						const prefix = settingsManager.getShellCommandPrefix();
						const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
						try {
							const result = await executeBashWithOperations(
								resolvedCommand,
								state.cwd,
								options.operations as BashOperations,
								{ onChunk, signal: abortController.signal },
							);
							if (state.sessionId === sessionAtStart) {
								await client.recordBashResult(command, result, options.excludeFromContext);
							}
							return result;
						} finally {
							localBashAbortController = undefined;
							localBashRunning = false;
							updateBashState();
						}
					}
					bashChunk = onChunk;
					try {
						return await client.bash(command, {
							excludeFromContext: options?.excludeFromContext,
							operations: options?.operations as Record<string, unknown> | undefined,
						});
					} finally {
						bashChunk = undefined;
					}
				};
			if (property === "abortBash")
				return () => {
					if (localBashAbortController) localBashAbortController.abort();
					else void client.abortBash().catch(reportActionFailure("abortBash"));
				};
			if (property === "getContextUsage") return () => state.contextUsage;
			if (property === "getSessionStats") return () => client.getSessionStats();
			if (property === "exportToHtml")
				return (outputPath?: string) => client.exportHtml(outputPath).then((result) => result.path);
			if (property === "setSessionName")
				return (name: string) => client.setSessionName(name).catch(reportActionFailure("setSessionName"));
			if (property === "navigateTree")
				return async (targetId: string, options?: Parameters<AgentSession["navigateTree"]>[1]) => {
					const result = await client.navigateTree(targetId, options);
					if (!result.cancelled) await refresh();
					return result;
				};
			if (property === "getUserMessagesForForking") return () => client.getForkMessages();
			if (property === "subscribe")
				return (listener: AgentSessionEventListener) => {
					listeners.add(listener);
					const localUnsubscribe = target.subscribe(listener);
					return () => {
						listeners.delete(listener);
						localUnsubscribe();
					};
				};
			if (property === "isStreaming") return state.isStreaming;
			if (property === "isCompacting") return state.isCompacting;
			if (property === "isFastModeActive") return () => state.fastMode;
			if (property === "pendingMessageCount") return state.pendingMessageCount;
			if (property === "getSteeringMessages") return () => state.steering;
			if (property === "getFollowUpMessages") return () => state.followUp;
			if (property === "clearQueue")
				return (options?: { abortWillFollow: boolean }) => {
					const result = {
						steering: [...state.steering],
						followUp: [...state.followUp],
						ordered: [...state.ordered],
					};
					Object.defineProperty(result, "ordered", { value: result.ordered, enumerable: false });
					void client.clearQueue(options).catch(reportActionFailure("clearQueue"));
					return result;
				};
			if (property === "abortBranchSummary")
				return () => void client.abortBranchSummary().catch(reportActionFailure("abortBranchSummary"));
			if (property === "recordBashResult")
				return (
					command: string,
					result: Parameters<AgentSession["recordBashResult"]>[1],
					options?: { excludeFromContext?: boolean },
				) =>
					void client
						.recordBashResult(command, result, options?.excludeFromContext)
						.catch(reportActionFailure("recordBashResult"));
			if (property === "set_label") return undefined;
			if (property === "retryAttempt") return state.retryAttempt;
			if (property === "isBashRunning") return state.isBashRunning;
			if (property === "reload") return (_options?: Parameters<AgentSession["reload"]>[0]) => client.reload();
			if (property === "checkReloadVeto") return () => client.checkReloadVeto();
			if (property === "exportToJsonl")
				return (outputPath?: string) => client.exportJsonl(outputPath).then((result) => result.path);
			// The footer and other renderers read session.state.*; surface the
			// host-authoritative fields there too, not only via the direct getters.
			if (property === "state") {
				const localState = target.state;
				return {
					...localState,
					model: state.model ?? localState.model,
					thinkingLevel: state.thinkingLevel,
					isStreaming: state.isStreaming,
					isCompacting: state.isCompacting,
				};
			}
			if (property === "sessionFile") return state.sessionFile;
			if (property === "sessionId") return state.sessionId;
			if (property === "sessionName") return state.sessionName;
			if (property === "serviceTier") return state.serviceTier;
			if (property === "sessionManager") return remoteSessionManager;
			if (property === "settingsManager") return settingsManager;
			if (property === "messages") return target.messages;
			if (property === "model") return state.model ?? target.model;
			if (property === "thinkingLevel") return state.thinkingLevel;
			return Reflect.get(target, property, receiver);
		},
	});
	return {
		session,
		setHostUiHandler: (callback) => {
			hostUiHandler = callback;
			if (callback)
				for (const request of pendingUiRequests.splice(0))
					void Promise.resolve(callback(request)).then(
						(response) => response && client.sendExtensionUIResponse(response),
					);
		},
		refresh,
		abortLocalBash: () => localBashAbortController?.abort(),
		createReplacedSessionContext: () => {
			const context = local.createReplacedSessionContext();
			Object.defineProperty(context, "cwd", { value: state.cwd });
			Object.defineProperty(context, "sessionManager", { value: remoteSessionManager });
			context.sendMessage = (message, options) =>
				client.sendCustomMessage(message, {
					triggerTurn: options?.triggerTurn,
					deliverAs: options?.deliverAs,
				});
			context.sendUserMessage = (content, options) => {
				if (typeof content === "string")
					return client.prompt(content, {
						streamingBehavior: options?.deliverAs,
						expandPromptTemplates: options?.expandPromptTemplates,
					});
				const text = content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const images = content.filter((part) => part.type === "image");
				return client.prompt(text, {
					images,
					streamingBehavior: options?.deliverAs,
					expandPromptTemplates: options?.expandPromptTemplates,
				});
			};
			return context;
		},
	};
}

function hydrateMessageUpdate(
	event: RpcClientEvent,
	streamingAssistant: Extract<AgentSession["messages"][number], { role: "assistant" }> | undefined,
): AgentSessionEvent {
	if (event.type !== "message_update" || !streamingAssistant) return event as unknown as AgentSessionEvent;
	const update = event.assistantMessageEvent;
	if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") {
		return event as unknown as AgentSessionEvent;
	}
	const content = streamingAssistant.content[update.contentIndex];
	if (update.type === "text_delta" && content?.type === "text") content.text += update.delta;
	if (update.type === "thinking_delta" && content?.type === "thinking") content.thinking += update.delta;
	if (update.type === "toolcall_delta" && content?.type === "toolCall") {
		const raw = JSON.stringify(content.arguments) + update.delta;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				content.arguments = parsed as Record<string, unknown>;
			}
		} catch {
			// Keep the last valid arguments until the next complete update.
		}
	}
	streamingAssistant.usage = event.usage;
	return {
		type: "message_update",
		message: structuredClone(streamingAssistant),
		assistantMessageEvent: { ...update, partial: structuredClone(streamingAssistant) },
	} as AgentSessionEvent;
}

function stateFromRpc(state: {
	model?: AgentSession["model"];
	thinkingLevel: AgentSession["thinkingLevel"];
	isStreaming: boolean;
	isCompacting: boolean;
	pendingMessageCount: number;
	usageTotals: import("../../core/session-manager.ts").UsageTotals;
	contextUsage?: import("../../core/extensions/types.ts").ContextUsage;
	retryAttempt: number;
	isBashRunning: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	cwd: string;
	projectTrusted: boolean;
	serviceTier?: AgentSession["serviceTier"];
	fastMode: boolean;
	entries?: import("../../core/session-manager.ts").SessionEntry[];
	steering: string[];
	followUp: string[];
	ordered: Array<{ text: string; mode: "steer" | "followUp"; enqueueOrder: number }>;
}) {
	return state;
}

export function isInteractiveHostEvent(event: RpcClientEvent): event is Extract<RpcClientEvent, { type: string }> {
	return typeof event === "object" && event !== null && "type" in event;
}
