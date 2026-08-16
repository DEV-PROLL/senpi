import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { detectRpcCommandInvocation } from "../src/modes/rpc/rpc-command-invocation.ts";

const sourceInfo = createSyntheticSourceInfo("rpc-command-invocation-test", { source: "test" });
const commands = [
	{ name: "hooks", description: "Manage hooks", source: "extension" as const, sourceInfo },
	{ name: "review", description: "Review work", source: "prompt" as const, sourceInfo },
	{ name: "skill:debugging", description: "Debug runtime failures", source: "skill" as const, sourceInfo },
];

describe("RPC command invocation events", () => {
	it("identifies accepted extension and prompt invocations", () => {
		expect(detectRpcCommandInvocation("/hooks list", commands)).toEqual({
			type: "command_invocation",
			command: { name: "hooks", source: "extension", sourceInfo, syntax: "slash" },
		});
		expect(detectRpcCommandInvocation("/review", commands)).toEqual({
			type: "command_invocation",
			command: { name: "review", source: "prompt", sourceInfo, syntax: "slash" },
		});
	});

	it("ignores skills, unknown commands, and ordinary dollar text", () => {
		expect(detectRpcCommandInvocation("/skill:debugging", commands)).toBeUndefined();
		expect(detectRpcCommandInvocation("/unknown", commands)).toBeUndefined();
		expect(detectRpcCommandInvocation("$HOME is literal", commands)).toBeUndefined();
	});
});
