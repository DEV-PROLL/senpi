import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

function fakeOAuth(name: string, credential: OAuthCredential): OAuthAuth {
	return {
		name,
		async login() {
			return credential;
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

describe("AuthStorage extension OAuth providers", () => {
	test("extension-registered oauth provider appears in getOAuthProviders", () => {
		const storage = AuthStorage.inMemory();
		const oauth = fakeOAuth("Claude Agent SDK (Claude Pro/Max)", {
			type: "oauth",
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
		});
		storage.registerOAuthProvider("claude-agent-sdk", oauth);
		expect(storage.getOAuthProviders()).toContainEqual({
			id: "claude-agent-sdk",
			name: "Claude Agent SDK (Claude Pro/Max)",
		});
	});

	test("login() runs the extension oauth flow and stores the credential", async () => {
		const storage = AuthStorage.inMemory();
		const credential: OAuthCredential = { type: "oauth", access: "a", refresh: "r", expires: 123 };
		storage.registerOAuthProvider("claude-agent-sdk", fakeOAuth("x", credential));
		await storage.login("claude-agent-sdk", {
			signal: undefined,
			onPrompt: async () => "",
			onAuth: async () => {},
			onManualCodeInput: async () => "",
		} as never);
		expect(await storage.read("claude-agent-sdk")).toEqual(credential);
	});

	test("unregisterOAuthProvider hides the provider again", () => {
		const storage = AuthStorage.inMemory();
		storage.registerOAuthProvider(
			"claude-agent-sdk",
			fakeOAuth("x", { type: "oauth", access: "", refresh: "", expires: 0 }),
		);
		storage.unregisterOAuthProvider("claude-agent-sdk");
		expect(storage.getOAuthProviders().map((p) => p.id)).not.toContain("claude-agent-sdk");
	});

	test("builtin providers still enumerate after dynamic registration", () => {
		const storage = AuthStorage.inMemory();
		storage.registerOAuthProvider(
			"claude-agent-sdk",
			fakeOAuth("x", { type: "oauth", access: "", refresh: "", expires: 0 }),
		);
		const ids = storage.getOAuthProviders().map((p) => p.id);
		expect(ids).toContain("anthropic");
		expect(ids).toContain("claude-agent-sdk");
	});
});
