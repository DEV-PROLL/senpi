import assert from "node:assert";
import { describe, it } from "node:test";
import {
	normalizeTmuxAllowPassthrough,
	probeTmuxImageState,
	type TmuxExecFile,
	tmuxSupportTier,
} from "../src/tmux-image-probe.ts";

describe("tmux image probe normalization", () => {
	it("normalizes historical option values by support tier", () => {
		const cases = [
			{ version: "3.2a", raw: "", tier: "unsupported", allow: "off" },
			{ version: "3.3", raw: "1", tier: "on-only", allow: "on" },
			{ version: "3.3a", raw: "on", tier: "on-only", allow: "on" },
			{ version: "3.4", raw: "all", tier: "on-and-all", allow: "all" },
			{ version: "3.7b", raw: "all", tier: "on-and-all", allow: "all" },
		] as const;

		for (const testCase of cases) {
			const tier = tmuxSupportTier(testCase.version);
			assert.strictEqual(tier, testCase.tier);
			assert.strictEqual(normalizeTmuxAllowPassthrough(testCase.raw, tier), testCase.allow);
		}
	});

	it("uses execFileSync-compatible argv without shell quoting", () => {
		const calls: Array<{ file: string; args: readonly string[] }> = [];
		const execFile: TmuxExecFile = (file, args) => {
			calls.push({ file, args });
			return "3.7b|on|on|1|1|1|xterm-ghostty|10|20|RGB,hyperlinks";
		};

		const state = probeTmuxImageState({ TERM: "tmux-256color", TMUX: "/tmp/tmux", TMUX_PANE: "%42" }, execFile);

		assert.deepStrictEqual(calls, [
			{
				file: "tmux",
				args: [
					"display-message",
					"-p",
					"-t",
					"%42",
					"#{version}|#{allow-passthrough}|#{focus-events}|#{pane_active}|#{window_active}|#{session_attached}|#{client_termname}|#{client_cell_width}|#{client_cell_height}|#{client_termfeatures}",
				],
			},
		]);
		assert.strictEqual(state.kind, "tmux");
		if (state.kind !== "tmux") return;
		assert.strictEqual(state.visible, true);
		assert.strictEqual(state.clientCount, 1);
		assert.strictEqual(state.hyperlinks, true);
		assert.deepStrictEqual(state.cellDimensions, { widthPx: 10, heightPx: 20 });
	});

	it("marks nested and multi-client sessions unsafe", () => {
		const nested = probeTmuxImageState({ TMUX: "/tmp/tmux" }, () => "3.7b|on|on|1|1|1|tmux-256color|9|18|hyperlinks");
		const multiClient = probeTmuxImageState(
			{ TMUX: "/tmp/tmux" },
			() => "3.7b|on|on|1|1|2|xterm-ghostty|9|18|hyperlinks",
		);

		assert.strictEqual(nested.kind, "tmux");
		assert.strictEqual(nested.kind === "tmux" && nested.nested, true);
		assert.strictEqual(multiClient.kind, "tmux");
		assert.strictEqual(multiClient.kind === "tmux" && multiClient.visible, false);
	});
});
