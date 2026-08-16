import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	buildRpcCommands,
	createCommandsChangedEvent,
	rpcCommandListDigest,
} from "../src/modes/rpc/rpc-command-surface.ts";

const sourceInfo = createSyntheticSourceInfo("rpc-commands-changed-test", { source: "test" });

describe("RPC command surface updates", () => {
	it("publishes the ordered command surface once per distinct snapshot", () => {
		const commands = buildRpcCommands({
			extensionCommands: [{ name: "hooks", description: "Manage hooks", sourceInfo }],
			promptTemplates: [{ name: "review", description: "Review work", sourceInfo }],
			skills: [{ name: "debugging", description: "Debug runtime failures", sourceInfo }],
		});

		expect(commands.map(({ name, source, syntax }) => ({ name, source, syntax }))).toEqual([
			{ name: "hooks", source: "extension", syntax: "slash" },
			{ name: "review", source: "prompt", syntax: "slash" },
			{ name: "skill:debugging", source: "skill", syntax: "dollar" },
		]);

		const event = createCommandsChangedEvent(undefined, commands);
		expect(event).toEqual({ type: "commands_changed", commands });
		expect(createCommandsChangedEvent(rpcCommandListDigest(commands), commands)).toBeUndefined();
	});
});
