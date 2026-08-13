import { describe, expect, it, vi } from "vitest";
import { probeAmbientClaudeAuthStatus } from "../src/core/extensions/builtin/claude-sdk-oauth/availability.ts";

type CloseListener = (code: number | null) => void;

function stubChild() {
	const listeners = { close: undefined as CloseListener | undefined };
	const kill = vi.fn();
	const child = {
		once(event: "error" | "close", listener: (...args: never[]) => void) {
			if (event === "close") listeners.close = listener as CloseListener;
			return child;
		},
		kill,
	};
	return { child, kill, closeWith: (code: number | null) => listeners.close?.(code) };
}

describe("ambient Claude auth probe deadline", () => {
	it("reports unavailable and kills the child when the status command never exits", async () => {
		const { child, kill } = stubChild();

		const available = await probeAmbientClaudeAuthStatus({ timeoutMs: 1, spawnProbe: () => child });

		expect(available).toBe(false);
		expect(kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("keeps a prompt exit authoritative and leaves the child alone", async () => {
		const { child, kill, closeWith } = stubChild();

		const probed = probeAmbientClaudeAuthStatus({ timeoutMs: 30_000, spawnProbe: () => child });
		closeWith(0);

		expect(await probed).toBe(true);
		expect(kill).not.toHaveBeenCalled();
	});
});
