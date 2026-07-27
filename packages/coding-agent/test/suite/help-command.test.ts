import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import helpExtension from "../../src/core/extensions/builtin/help/index.ts";
import { HELP_OVERLAY_MARGIN, HelpPanel } from "../../src/core/extensions/builtin/help/panel.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { SlashCommandInfo } from "../../src/core/slash-commands.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";
import { testTheme } from "./history-search-fixtures.ts";

const harnesses: Harness[] = [];

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;
type HelpFactory = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: undefined) => void,
) => Component | Promise<Component>;

function fakeTui(rows: number): TUI {
	return {
		terminal: { rows },
		requestRender: vi.fn(),
	} as unknown as TUI;
}

function createCommandFixture() {
	const commands = new Map<string, CommandOptions>();
	const extensionCommands: SlashCommandInfo[] = [
		{
			name: "inspect-help",
			description: "Inspect help rendering",
			source: "extension",
			sourceInfo: { path: "test", source: "test", scope: "temporary", origin: "top-level" },
		},
	];
	const api = {
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
		getCommands: () => extensionCommands,
	} as unknown as ExtensionAPI;

	helpExtension(api);
	const command = commands.get("help");
	if (!command) throw new Error("Expected /help command to be registered");
	return command;
}

function plain(lines: string[]): string {
	return stripAnsi(lines.join("\n"));
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("help builtin extension", () => {
	it("adds /help to the loaded extension command list", async () => {
		const harness = await createHarness({ extensionFactories: [helpExtension] });
		harnesses.push(harness);

		const command = harness
			.getExtensionRunner()
			.getRegisteredCommands()
			.find((item) => item.name === "help");

		expect(command?.invocationName).toBe("help");
		expect(command?.description).toBe("Show usage, keybindings, and all commands");
	});

	it("renders all help sections plus builtin and extension commands in a focused overlay", async () => {
		const command = createCommandFixture();
		const tui = fakeTui(500);
		const keybindings = new KeybindingsManager();
		let component: Component | undefined;
		const custom = vi.fn(async (factory: HelpFactory) => {
			component = await factory(tui, testTheme, keybindings, () => {});
		});
		const ctx = {
			mode: "tui",
			ui: { custom, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await command.handler("", ctx);

		expect(custom).toHaveBeenCalledOnce();
		expect(custom.mock.calls[0]?.[1]).toMatchObject({ overlay: true });
		const output = plain(component?.render(120) ?? []);
		expect(output).toContain("Getting started");
		expect(output).toContain("Keybindings");
		expect(output).toContain("Commands");
		expect(output).toContain("/settings");
		expect(output).toContain("/inspect-help");
	});

	it("owns a small viewport and changes the visible slice on page down", () => {
		const tui = fakeTui(8);
		const done = vi.fn();
		const panel = new HelpPanel({
			markdown: ["## TOP", ...Array.from({ length: 20 }, (_, index) => `paragraph ${index + 1}`)].join("\n\n"),
			tui,
			theme: testTheme,
			keybindings: new KeybindingsManager(),
			done,
		});

		const initial = panel.render(60);
		expect(initial).toHaveLength(8 - HELP_OVERLAY_MARGIN * 2);
		expect(plain(initial)).toContain("TOP");

		panel.handleInput("\x1b[6~");
		const paged = panel.render(60);
		expect(paged).not.toEqual(initial);
		expect(plain(paged)).not.toContain("TOP");

		panel.handleInput("\x1b");
		expect(done).toHaveBeenCalledOnce();
	});

	it("uses a one-line notification outside TUI mode without opening custom UI", async () => {
		const command = createCommandFixture();
		const notify = vi.fn();
		const custom = vi.fn();
		const ctx = {
			mode: "print",
			ui: { notify, custom },
		} as unknown as ExtensionCommandContext;

		await command.handler("", ctx);

		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]?.[0]).not.toContain("\n");
		expect(notify.mock.calls[0]?.[0]).toContain("TUI");
	});
});
