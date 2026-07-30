import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("idleCompactionEnabled setting", () => {
	it("defaults to true", () => {
		const sm = SettingsManager.inMemory();
		expect(sm.getCompactionSettings().idleCompactionEnabled).toBe(true);
	});

	it("respects false when explicitly set", () => {
		const sm = SettingsManager.inMemory({ compaction: { idleCompactionEnabled: false } });
		expect(sm.getCompactionSettings().idleCompactionEnabled).toBe(false);
	});
});
