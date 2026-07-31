import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import claudeSdkOauthExtension from "../src/core/extensions/builtin/claude-sdk-oauth/index.ts";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type FakeExtension = {
	api: ExtensionAPI;
	handlers: Map<string, EventHandler[]>;
};

const sessionIds = new Set<string>();

function fakeQuery(onClose?: () => void): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {
			onClose?.();
		},
	};
}

function fakeExtension(): FakeExtension {
	const handlers = new Map<string, EventHandler[]>();
	const api = {
		on(event: string, handler: EventHandler): void {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		getFlag(): undefined {
			return undefined;
		},
		registerFlag(): void {},
		registerCommand(): void {},
		registerProvider(): void {},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

function context(sessionId: string): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

function createEntry(sessionId: string, onClose?: () => void): void {
	sessionIds.add(sessionId);
	overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery(onClose) });
	getOrCreateSession({
		senpiSessionId: sessionId,
		accountName: "default",
		modelId: "claude-test",
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
	});
}

async function emitTwice(
	extension: FakeExtension,
	eventName: string,
	event: unknown,
	sessionId: string,
): Promise<void> {
	const handlers = extension.handlers.get(eventName) ?? [];
	expect(handlers).toHaveLength(1);
	for (const handler of handlers) {
		await handler(event, context(sessionId));
		await handler(event, context(sessionId));
	}
}

afterEach(() => {
	for (const sessionId of sessionIds) closeSession(sessionId, "test_cleanup");
	sessionIds.clear();
	resetSessionRegistryBoundary();
});

describe("Claude SDK OAuth session registry lifecycle wiring", () => {
	it("taints a compacted session idempotently", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry("compact-session");

		await emitTwice(extension, "session_compact", { type: "session_compact" }, "compact-session");

		expect(getSession("compact-session")).toMatchObject({ state: "TAINTED", taintedReason: "compaction" });
	});

	it("taints a session before fork idempotently", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry("fork-session");

		await emitTwice(extension, "session_before_fork", { type: "session_before_fork" }, "fork-session");

		expect(getSession("fork-session")).toMatchObject({ state: "TAINTED", taintedReason: "fork" });
	});

	it("records tree branch boundaries without tainting", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry("tree-session");

		await emitTwice(
			extension,
			"session_tree",
			{ type: "session_tree", oldLeafId: "old-leaf", newLeafId: "new-leaf" },
			"tree-session",
		);

		expect(getSession("tree-session")).toMatchObject({
			state: "STARTING",
			taintedReason: null,
			branchInfo: { oldLeafId: "old-leaf", newLeafId: "new-leaf" },
		});
	});

	it.each(["quit", "new", "resume", "fork", "reload"] as const)(
		"closes a session on %s shutdown idempotently",
		async (reason) => {
			let closes = 0;
			const extension = fakeExtension();
			registerSessionRegistry(extension.api);
			createEntry(`shutdown-${reason}`, () => closes++);

			await emitTwice(extension, "session_shutdown", { type: "session_shutdown", reason }, `shutdown-${reason}`);

			expect(getSession(`shutdown-${reason}`)).toBeUndefined();
			expect(closes).toBe(1);
		},
	);

	it("closes a session when the extension is removed idempotently", async () => {
		let closes = 0;
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry("removed-session", () => closes++);

		await emitTwice(
			extension,
			"session_extensions_removed",
			{ type: "session_extensions_removed", reason: "reload", removed: [] },
			"removed-session",
		);

		expect(getSession("removed-session")).toBeUndefined();
		expect(closes).toBe(1);
	});

	it("registers lifecycle wiring from the production extension factory", () => {
		const extension = fakeExtension();

		claudeSdkOauthExtension(extension.api);

		expect(extension.handlers.get("session_compact")).toHaveLength(1);
		expect(extension.handlers.get("session_before_fork")).toHaveLength(1);
		expect(extension.handlers.get("session_tree")).toHaveLength(1);
		expect(extension.handlers.get("session_extensions_removed")).toHaveLength(1);
		expect(extension.handlers.get("session_shutdown")).toHaveLength(2);
	});
});
