import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";

type AnyTool = ToolDefinition;
type EventHandler = (data: unknown) => Promise<void> | void;
export type GoalHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
export type SentGoalMessage = {
	readonly message: { readonly customType: string; readonly content: string; readonly display: boolean };
	readonly options: unknown;
};

export class TestEventBus {
	readonly emitted: Array<{ channel: string; data: unknown }> = [];
	readonly #handlers = new Map<string, EventHandler[]>();
	#pending: Promise<void>[] = [];

	emit(channel: string, data: unknown): void {
		this.emitted.push({ channel, data });
		for (const handler of this.#handlers.get(channel) ?? []) {
			this.#pending.push(Promise.resolve(handler(data)));
		}
	}

	on(channel: string, handler: EventHandler): () => void {
		const handlers = this.#handlers.get(channel) ?? [];
		handlers.push(handler);
		this.#handlers.set(channel, handlers);
		return () => {
			const index = handlers.indexOf(handler);
			if (index >= 0) handlers.splice(index, 1);
		};
	}

	async flush(): Promise<void> {
		const pending = this.#pending;
		this.#pending = [];
		await Promise.all(pending);
	}
}

export type AppendedGoalEntry = { readonly customType: string; readonly data: unknown };

export interface GoalHarness {
	readonly tools: Map<string, AnyTool>;
	readonly handlers: Map<string, GoalHandler[]>;
	readonly sent: SentGoalMessage[];
	readonly events: TestEventBus;
	readonly entries: AppendedGoalEntry[];
}

export interface GoalContextState {
	pendingMessages: boolean;
	model?: Model<Api>;
}

export function createGoalHarness(): GoalHarness {
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, GoalHandler[]>();
	const sent: SentGoalMessage[] = [];
	const events = new TestEventBus();
	const entries: AppendedGoalEntry[] = [];
	const pi = {
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
		on: (event: string, handler: GoalHandler) => {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		sendMessage: (message: SentGoalMessage["message"], options: unknown) => sent.push({ message, options }),
		events,
	} as unknown as ExtensionAPI;
	goalExtension(pi);
	return { tools, handlers, sent, events, entries };
}

const tempDirs: string[] = [];

export async function makeGoalContext(
	notices: string[],
	threadId: string,
	state: GoalContextState = { pendingMessages: false },
): Promise<ExtensionContext> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-monitor-"));
	tempDirs.push(dir);
	return {
		hasUI: true,
		cwd: dir,
		model: state.model,
		isIdle: () => true,
		hasPendingMessages: () => state.pendingMessages,
		ui: {
			notify: (message: string) => notices.push(message),
			select: async () => undefined,
			setStatus: () => {},
		},
		sessionManager: {
			getSessionFile: () => join(dir, "session.jsonl"),
			getSessionDir: () => dir,
			getSessionId: () => threadId,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
}

export async function cleanupGoalMonitorTempDirs(): Promise<void> {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export function waitForGoalContinuationCount(ctx: ExtensionContext, expectedCount: number): Promise<void> {
	const baseDir = join(ctx.sessionManager.getSessionDir(), "extensions", "goal");
	const threadId = ctx.sessionManager.getSessionId();
	const goalFileName = `${encodeURIComponent(threadId)}.json`;
	return new Promise((resolve, reject) => {
		let completed = false;
		let timeout: ReturnType<typeof setRealTimeout> | undefined;
		const watcher = watch(baseDir, { encoding: "utf8" }, (_eventType, changedFileName) => {
			if (changedFileName !== goalFileName) return;
			void readGoal({ baseDir, threadId }).then((goal) => {
				if (goal?.consecutiveContinuations === expectedCount) complete();
			}, complete);
		});
		timeout = setRealTimeout(
			() => complete(new Error(`Timed out waiting for continuation count ${expectedCount}`)),
			5_000,
		);
		watcher.once("error", complete);

		function complete(error: Error | undefined = undefined): void {
			if (completed) return;
			completed = true;
			if (timeout !== undefined) clearRealTimeout(timeout);
			watcher.close();
			if (error === undefined) resolve();
			else reject(error);
		}
	});
}

export async function runGoalHandlers(
	handlers: Map<string, GoalHandler[]>,
	event: string,
	payload: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of handlers.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

export type AssistantUsageOverrides = Partial<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}>;

export function cleanAssistantStop(usageOverrides: AssistantUsageOverrides = {}): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...usageOverrides,
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
