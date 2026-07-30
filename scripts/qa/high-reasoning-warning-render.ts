import { Container } from "../../packages/tui/src/tui.ts";
import { Spacer } from "../../packages/tui/src/components/spacer.ts";
import { Text } from "../../packages/tui/src/components/text.ts";
import { DynamicBorder } from "../../packages/coding-agent/src/modes/interactive/components/dynamic-border.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { buildHighReasoningWarning } from "../../packages/coding-agent/src/core/high-reasoning-warning.ts";

initTheme("dark");
const event = { modelId: "gpt-5.6-sol", provider: "openai", thinkingLevel: "xhigh" as const };
const { title, body } = buildHighReasoningWarning({ id: event.modelId, provider: event.provider }, event.thinkingLevel);
const chat = new Container();
chat.addChild(new Spacer(1));
chat.addChild(new DynamicBorder((s) => theme.fg("error", s)));
chat.addChild(
	new Text(`${theme.bold(theme.fg("error", title))}\n${body.map((l) => theme.fg("error", l)).join("\n")}`, 1, 0),
);
chat.addChild(new DynamicBorder((s) => theme.fg("error", s)));
const lines = chat.children.flatMap((c) => c.render(100));
process.stdout.write(lines.join("\n") + "\n");
