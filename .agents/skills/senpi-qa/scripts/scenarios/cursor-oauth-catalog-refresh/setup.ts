import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../../../../../packages/coding-agent/src/core/auth-storage.ts";
import {
	registerCursorCliAccountCommand,
} from "../../../../../../packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/account-command.ts";
import {
	persistCursorCliNoApprovalAcknowledgement,
} from "../../../../../../packages/coding-agent/src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "../../../../../../packages/coding-agent/src/core/extensions/types.ts";

type Command = Pick<RegisteredCommand, "handler">;

const [agentDir, cwd] = process.argv.slice(2);
if (!agentDir || !cwd) throw new Error("usage: setup.ts <agent-dir> <cwd>");
process.env.SENPI_CODING_AGENT_DIR = agentDir;

const nativeCredential: Credential = {
	type: "oauth",
	access: "qa-native-access",
	refresh: "qa-native-refresh",
	expires: Date.now() + 3_600_000,
};
const authPath = join(agentDir, "auth.json");
const storage = AuthStorage.create(authPath);
storage.set("cursor", nativeCredential);
const nativeBefore = JSON.stringify(storage.get("cursor"));

let command: Command | undefined;
const pi = {
	registerCommand: (name: string, registered: Command) => {
		if (name === "cursor-account") command = registered;
	},
	on: () => {},
} as unknown as ExtensionAPI;
registerCursorCliAccountCommand(pi);
if (!command) throw new Error("/cursor-account was not registered");

const notices: Array<{ message: string; type?: string }> = [];
const refreshCalls: unknown[] = [];
const ctx = {
	hasUI: false,
	cwd,
	signal: undefined,
	isIdle: () => true,
	sessionManager: { getSessionId: () => "cursor-oauth-catalog-refresh-qa" },
	modelRegistry: {
		authStorage: storage,
		modelRuntime: {
			refresh: async (options: unknown) => {
				refreshCalls.push(options);
				return { aborted: false, errors: new Map() };
			},
		},
	},
	ui: {
		notify: (message: string, type?: string) => notices.push({ message, type }),
		input: async () => undefined,
	},
} as unknown as ExtensionCommandContext;

await command.handler("import native", ctx);
persistCursorCliNoApprovalAcknowledgement(cwd, "2026-08-18T02:45:00.000Z");

const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
const target = stored["cursor-cli-oauth"] as
	| {
			accounts?: Array<{ name?: unknown; source?: unknown; access?: unknown; refresh?: unknown }>;
		}
	| undefined;
const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
	cursorCliOauthProvider?: { enabled?: unknown; noApprovalAcknowledgedAt?: unknown };
};
const account = target?.accounts?.[0];

process.stdout.write(
	`${JSON.stringify({
		nativePreserved: JSON.stringify(storage.get("cursor")) === nativeBefore,
		targetCreated: target !== undefined,
		accountName: account?.name,
		accountSource: account?.source,
		accountMatchesNative:
			account?.access === nativeCredential.access && account?.refresh === nativeCredential.refresh,
		enabled: settings.cursorCliOauthProvider?.enabled === true,
		acknowledged:
			settings.cursorCliOauthProvider?.noApprovalAcknowledgedAt === "2026-08-18T02:45:00.000Z",
		refreshRequested: refreshCalls.some(
			(value) =>
				typeof value === "object" &&
				value !== null &&
				(value as { allowNetwork?: unknown }).allowNetwork === false &&
				Array.isArray((value as { providers?: unknown }).providers) &&
				(value as { providers: unknown[] }).providers.includes("cursor-cli-oauth"),
		),
		successNotice: notices.some(
			(notice) => notice.type === "info" && notice.message.includes("Imported native Cursor credential"),
		),
	})}\n`,
);
