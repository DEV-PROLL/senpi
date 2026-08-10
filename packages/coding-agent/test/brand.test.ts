import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BRAND_ENV_VAR, consumeBrandProfile, parseBrandProfile } from "../src/core/brand.ts";

const OMO_PROFILE = JSON.stringify({
	name: "omo",
	displayVersion: "9.9.9",
	configDir: ".omo",
	flatLayout: true,
	envPrefix: "OMO",
	userAgent: "omo",
	originator: "omo",
});

describe("parseBrandProfile", () => {
	let stderr: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderr.mockRestore();
	});

	test("returns undefined when the variable is absent or empty", () => {
		expect(parseBrandProfile(undefined)).toBeUndefined();
		expect(parseBrandProfile("")).toBeUndefined();
		expect(parseBrandProfile("   ")).toBeUndefined();
		expect(stderr).not.toHaveBeenCalled();
	});

	test("reports and ignores malformed JSON instead of throwing", () => {
		expect(parseBrandProfile("{broken")).toBeUndefined();
		expect(stderr).toHaveBeenCalledOnce();
		expect(String(stderr.mock.calls[0]?.[0])).toContain(BRAND_ENV_VAR);
	});

	test("ignores JSON that is not an object, and objects without a name", () => {
		expect(parseBrandProfile('"omo"')).toBeUndefined();
		expect(parseBrandProfile("[1,2]")).toBeUndefined();
		expect(parseBrandProfile('{"displayVersion":"1.0.0"}')).toBeUndefined();
	});

	test("fills defaults from the name when optional fields are omitted", () => {
		const profile = parseBrandProfile('{"name":"omo"}');

		expect(profile).toEqual({
			name: "omo",
			displayVersion: undefined,
			configDir: ".omo",
			flatLayout: false,
			envPrefix: "OMO",
			userAgent: "omo",
			originator: undefined,
		});
	});

	test("keeps every field of a complete profile", () => {
		expect(parseBrandProfile(OMO_PROFILE)).toEqual({
			name: "omo",
			displayVersion: "9.9.9",
			configDir: ".omo",
			flatLayout: true,
			envPrefix: "OMO",
			userAgent: "omo",
			originator: "omo",
		});
	});
});

describe("consumeBrandProfile", () => {
	test("removes the variable so child processes inherit a clean environment", () => {
		const env: NodeJS.ProcessEnv = { [BRAND_ENV_VAR]: OMO_PROFILE, PATH: "/usr/bin" };

		const profile = consumeBrandProfile(env);

		expect(profile?.name).toBe("omo");
		expect(BRAND_ENV_VAR in env).toBe(false);
		expect(env.PATH).toBe("/usr/bin");
	});

	test("still scrubs the variable when the payload is unusable", () => {
		const env: NodeJS.ProcessEnv = { [BRAND_ENV_VAR]: "{broken" };
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		expect(consumeBrandProfile(env)).toBeUndefined();
		expect(BRAND_ENV_VAR in env).toBe(false);

		stderr.mockRestore();
	});
});

describe("config module brand integration", () => {
	const savedBrand = process.env[BRAND_ENV_VAR];

	afterEach(() => {
		if (savedBrand === undefined) delete process.env[BRAND_ENV_VAR];
		else process.env[BRAND_ENV_VAR] = savedBrand;
		vi.resetModules();
	});

	test("standalone install keeps the engine identity", async () => {
		delete process.env[BRAND_ENV_VAR];
		vi.resetModules();

		const config = await import("../src/config.ts");

		expect(config.APP_NAME).toBe("senpi");
		expect(config.CONFIG_DIR_NAME).toBe(".senpi");
		expect(config.CONFIG_FLAT_LAYOUT).toBe(false);
		expect(config.DISPLAY_VERSION).toBe(config.VERSION);
		expect(config.ENV_AGENT_DIR).toBe("SENPI_CODING_AGENT_DIR");
	});

	test("branded install renames the product and scrubs the variable", async () => {
		process.env[BRAND_ENV_VAR] = OMO_PROFILE;
		vi.resetModules();

		const config = await import("../src/config.ts");

		expect(config.APP_NAME).toBe("omo");
		expect(config.APP_TITLE).toBe("omo");
		expect(config.CONFIG_DIR_NAME).toBe(".omo");
		expect(config.CONFIG_FLAT_LAYOUT).toBe(true);
		expect(config.DISPLAY_VERSION).toBe("9.9.9");
		expect(config.ENV_AGENT_DIR).toBe("OMO_CODING_AGENT_DIR");
		expect(process.env[BRAND_ENV_VAR]).toBeUndefined();
	});
});
