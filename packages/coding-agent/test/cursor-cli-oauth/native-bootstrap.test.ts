import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { CURSOR_CLI_OAUTH_PROVIDER_ID } from "../../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import {
	type CursorCliNativeBootstrapDeps,
	createCursorCliOauthCredentialReader,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/native-bootstrap.ts";

describe("cursor-cli-oauth native bootstrap reader", () => {
	it("does not read or copy native credentials when the caller gate is false", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("cursor", async () => ({
			type: "oauth",
			access: "native-access",
			refresh: "native-refresh",
			expires: Date.now() + 3_600_000,
		}));
		const readNativeCredential = vi.fn(() => store.read("cursor"));
		const reader = createCursorCliOauthCredentialReader({
			store,
			readNativeCredential,
			canBootstrap: () => false,
		} as CursorCliNativeBootstrapDeps & { canBootstrap: () => boolean });

		await expect(reader()).resolves.toBeUndefined();
		expect(readNativeCredential).not.toHaveBeenCalled();
		expect(await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID)).toBeUndefined();
	});
});
