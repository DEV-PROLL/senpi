import { buildHelpMarkdown } from "../../../../modes/interactive/help-content.ts";
import type { ExtensionAPI } from "../../types.ts";
import { HELP_OVERLAY_OPTIONS, HelpPanel } from "./panel.ts";

const NON_TUI_HELP = "Interactive /help is available in TUI mode; run senpi --help for CLI usage.";

export default function helpExtension(pi: ExtensionAPI): void {
	pi.registerCommand("help", {
		description: "Show usage, keybindings, and all commands",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(NON_TUI_HELP, "info");
				return;
			}

			const markdown = buildHelpMarkdown({ extensionCommands: pi.getCommands() });
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => new HelpPanel({ markdown, tui, theme, keybindings, done }),
				{ overlay: true, overlayOptions: HELP_OVERLAY_OPTIONS },
			);
		},
	});
}
