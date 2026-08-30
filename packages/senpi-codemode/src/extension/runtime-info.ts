import type { InterpreterAvailability } from "../interpreters/detect.ts";
import type { EvalLanguage, EvalRuntimeInfo, EvalRuntimes } from "../tool/types.ts";

export interface JsRuntimeVersions {
	readonly node: string;
	readonly bun?: string | undefined;
}

/**
 * Markers a compiled standalone bun binary leaves in module urls: posix
 * virtual filesystem, windows virtual drive, and its percent-encoded form.
 * Mirrors the detection in packages/coding-agent/src/config.ts.
 */
const NATIVE_MODULE_URL_MARKERS = ["$bunfs", "~BUN", "%7EBUN"] as const;

export interface NativeRuntimeSignals {
	readonly bunVersion?: string | undefined;
	readonly moduleUrl?: string | undefined;
}

/**
 * True when the bun runtime hosting this code is a compiled standalone binary
 * (an omo/pi native build): the in-process JS kernel then runs inside the
 * application binary itself rather than a stock bun install.
 */
export function isNativeSelfRuntime(signals: NativeRuntimeSignals = processNativeSignals()): boolean {
	const bun = signals.bunVersion;
	if (bun === undefined || bun.length === 0) return false;
	const moduleUrl = signals.moduleUrl ?? "";
	return NATIVE_MODULE_URL_MARKERS.some((marker) => moduleUrl.includes(marker));
}

function processNativeSignals(): NativeRuntimeSignals {
	return { bunVersion: process.versions.bun, moduleUrl: import.meta.url };
}

/**
 * Identity of the in-process JS kernel host: native when a compiled binary
 * hosts the kernel itself, bun when its marker exists, node otherwise.
 */
export function jsRuntimeInfo(
	versions: JsRuntimeVersions = process.versions,
	execPath: string = process.execPath,
	nativeSelf: boolean = isNativeSelfRuntime(),
): EvalRuntimeInfo {
	const bun = versions.bun;
	if (bun !== undefined && bun.length > 0) {
		return { name: nativeSelf ? "native" : "bun", version: bun, path: execPath };
	}
	return { name: "node", version: versions.node, path: execPath };
}

/**
 * Short host-line segment, e.g. "node 26.7.0" or "bun 1.4.0". Stays
 * runtime-truthful for the eval prompt, so a native binary still reads "bun":
 * the model needs the engine capability surface, not the install identity.
 */
export function jsRuntimeLabel(versions: JsRuntimeVersions = process.versions): string {
	const info = jsRuntimeInfo(versions, "", false);
	return `${info.name} ${info.version}`;
}

const subprocessRuntimeNames = { py: "python", rb: "ruby", jl: "julia" } as const;
const subprocessLanguages = ["py", "rb", "jl"] as const;

/** Maps detected interpreters to display runtimes, preferring resolved absolute paths. */
export function runtimesFromAvailability(availability: InterpreterAvailability, js: EvalRuntimeInfo): EvalRuntimes {
	const runtimes: Partial<Record<EvalLanguage, EvalRuntimeInfo>> = { js };
	for (const language of subprocessLanguages) {
		const detected = availability[language].detected;
		if (!detected.ok) continue;
		runtimes[language] = {
			name: subprocessRuntimeNames[language],
			version: detected.version,
			path: detected.resolvedPath ?? detected.path,
		};
	}
	return runtimes;
}
