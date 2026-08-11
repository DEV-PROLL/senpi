import { describe, expect, it, vi } from "vitest";
import { createAmbientAuthStatusReader } from "../src/core/extensions/builtin/claude-sdk-oauth/availability.ts";

describe("ambient Claude auth status cache", () => {
	it("probes once for repeated reads inside the TTL", async () => {
		const probe = vi.fn(async () => true);
		let clock = 1_000;
		const read = createAmbientAuthStatusReader(probe, () => clock, 30_000);

		expect(await read()).toBe(true);
		clock += 29_999;
		expect(await read()).toBe(true);

		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("re-probes once the TTL has elapsed", async () => {
		const probe = vi.fn(async () => true);
		let clock = 1_000;
		const read = createAmbientAuthStatusReader(probe, () => clock, 30_000);

		await read();
		clock += 30_000;
		await read();

		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("shares one in-flight probe between concurrent reads", async () => {
		let release: ((value: boolean) => void) | undefined;
		const probe = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
		const read = createAmbientAuthStatusReader(probe, () => 1_000, 30_000);

		const both = Promise.all([read(), read()]);
		release?.(true);

		expect(await both).toEqual([true, true]);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("does not cache a rejected probe", async () => {
		const probe = vi.fn().mockRejectedValueOnce(new Error("spawn failed")).mockResolvedValueOnce(true);
		const read = createAmbientAuthStatusReader(probe, () => 1_000, 30_000);

		await expect(read()).rejects.toThrow("spawn failed");
		expect(await read()).toBe(true);
		expect(probe).toHaveBeenCalledTimes(2);
	});
});
