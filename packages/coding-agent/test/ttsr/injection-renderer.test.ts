import { afterEach, beforeAll, describe, expect, it } from "vitest";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { renderTtsrInjectionEntry } from "../../src/core/extensions/builtin/ttsr/injection-renderer.ts";
import { TTSR_INJECTION_CUSTOM_TYPE, type TtsrInjectionRecord } from "../../src/core/extensions/builtin/ttsr/types.ts";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function injectionEntry(record: TtsrInjectionRecord): CustomEntry<TtsrInjectionRecord> {
	return {
		type: "custom",
		id: "entry-ttsr-1",
		parentId: null,
		timestamp: "2026-08-04T00:00:00.000Z",
		customType: TTSR_INJECTION_CUSTOM_TYPE,
		data: record,
	};
}

function renderToText(record: TtsrInjectionRecord, expanded = false): string {
	const component = renderTtsrInjectionEntry(injectionEntry(record), { expanded }, theme);
	return (component?.render(100) ?? []).join("\n").replace(ANSI_PATTERN, "");
}

describe("ttsr injection entry renderer", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a collapse-repetition nudge as a warning notice box", () => {
		const text = renderToText({
			rules: ["collapse-repetition"],
			owner: "collapse-repetition",
			remediation: "nudge",
			at: Date.parse("2026-08-04T00:00:00.000Z"),
		});
		expect(text).toContain("Stream rule");
		expect(text).toContain("collapse-repetition");
	});

	it("distinguishes the provider-error remediation from the nudge remediation", () => {
		const base = { rules: ["control-token-leak"], owner: "control-token-leak" } as const;
		const nudge = renderToText({ ...base, remediation: "nudge", at: 0 });
		const providerError = renderToText({ ...base, remediation: "provider-error", at: 0 });
		expect(nudge).not.toBe(providerError);
		expect(providerError).toContain("control-token-leak");
	});

	it("reveals rules, remediation, and the record time only when expanded", () => {
		const record: TtsrInjectionRecord = {
			rules: ["collapse-repetition"],
			owner: "collapse-repetition",
			remediation: "nudge",
			at: Date.parse("2026-08-04T00:00:00.000Z"),
		};
		expect(renderToText(record)).not.toContain("2026-08-04T00:00:00.000Z");
		expect(renderToText(record, true)).toContain("2026-08-04T00:00:00.000Z");
	});

	it("returns undefined for entries without data", () => {
		const entry: CustomEntry<TtsrInjectionRecord> = {
			type: "custom",
			id: "entry-ttsr-empty",
			parentId: null,
			timestamp: "2026-08-04T00:00:00.000Z",
			customType: TTSR_INJECTION_CUSTOM_TYPE,
		};
		expect(renderTtsrInjectionEntry(entry, { expanded: false }, theme)).toBeUndefined();
	});
});

describe("ttsr injection renderer wiring", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("registers the entry renderer under the ttsr injection custom type", async () => {
		harness = await createHarness({ extensionFactories: [ttsrExtension] });
		expect(harness.session.extensionRunner.getEntryRenderer(TTSR_INJECTION_CUSTOM_TYPE)).toBe(
			renderTtsrInjectionEntry,
		);
	});
});
