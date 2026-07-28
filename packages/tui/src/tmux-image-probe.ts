import { execFileSync } from "node:child_process";

interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export type TmuxSupportTier = "unsupported" | "on-only" | "on-and-all";
export type TmuxAllowPassthrough = "off" | "on" | "all";

export type TmuxExecFile = (file: string, args: readonly string[]) => string;

interface TmuxBaseState {
	readonly supportTier: TmuxSupportTier;
	readonly allowPassthrough: TmuxAllowPassthrough;
	readonly focusEvents: boolean;
	readonly paneActive: boolean;
	readonly windowActive: boolean;
	readonly visible: boolean;
	readonly clientCount: number;
	readonly clientTermname: string;
	readonly nested: boolean;
	readonly hyperlinks: boolean;
	readonly cellDimensions?: CellDimensions;
}

export interface TmuxOutsideState extends TmuxBaseState {
	readonly kind: "outside";
}

export interface TmuxUnavailableState extends TmuxBaseState {
	readonly kind: "unavailable";
	readonly reason: "probe-failed" | "malformed-output";
}

export interface TmuxDetectedState extends TmuxBaseState {
	readonly kind: "tmux";
	readonly version: string;
}

export type TmuxImageState = TmuxOutsideState | TmuxUnavailableState | TmuxDetectedState;

export const TMUX_IMAGE_FORMAT =
	"#{version}|#{allow-passthrough}|#{focus-events}|#{pane_active}|#{window_active}|#{session_attached}|#{client_termname}|#{client_cell_width}|#{client_cell_height}|#{client_termfeatures}";

const DISABLED_STATE = {
	supportTier: "unsupported",
	allowPassthrough: "off",
	focusEvents: false,
	paneActive: false,
	windowActive: false,
	visible: false,
	clientCount: 0,
	clientTermname: "",
	nested: false,
	hyperlinks: false,
} as const;

function defaultExecFile(file: string, args: readonly string[]): string {
	return execFileSync(file, [...args], {
		encoding: "utf8",
		timeout: 250,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function parseTmuxVersion(version: string): readonly [major: number, minor: number] | null {
	const match = /^(?:next-)?(\d+)\.(\d+)/.exec(version.trim());
	if (!match) return null;
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	return Number.isFinite(major) && Number.isFinite(minor) ? [major, minor] : null;
}

export function tmuxSupportTier(version: string): TmuxSupportTier {
	const parsed = parseTmuxVersion(version);
	if (!parsed) return "unsupported";
	const [major, minor] = parsed;
	if (major > 3 || (major === 3 && minor >= 4)) return "on-and-all";
	if (major === 3 && minor === 3) return "on-only";
	return "unsupported";
}

export function normalizeTmuxAllowPassthrough(raw: string, supportTier: TmuxSupportTier): TmuxAllowPassthrough {
	if (supportTier === "unsupported") return "off";
	const value = raw.trim().toLowerCase();
	if (value === "1" || value === "on") return "on";
	if (value === "all" && supportTier === "on-and-all") return "all";
	return "off";
}

function parseBoolean(raw: string): boolean {
	const value = raw.trim().toLowerCase();
	return value === "1" || value === "on";
}

function parsePositiveInteger(raw: string): number | undefined {
	if (!/^\d+$/.test(raw)) return undefined;
	const value = Number.parseInt(raw, 10);
	return value > 0 ? value : undefined;
}

function parseClientCount(raw: string): number {
	if (!/^\d+$/.test(raw)) return 0;
	return Number.parseInt(raw, 10);
}

function isNestedClient(clientTermname: string): boolean {
	const term = clientTermname.trim().toLowerCase();
	return term.startsWith("tmux") || term.startsWith("screen");
}

export function parseTmuxImageState(output: string): TmuxImageState {
	const fields = output.trim().split("|");
	if (fields.length !== 10) {
		return { kind: "unavailable", reason: "malformed-output", ...DISABLED_STATE };
	}

	const [
		version = "",
		rawAllow = "",
		rawFocusEvents = "",
		rawPaneActive = "",
		rawWindowActive = "",
		rawClientCount = "",
		rawClientTermname = "",
		rawCellWidth = "",
		rawCellHeight = "",
		rawTermfeatures = "",
	] = fields;
	const supportTier = tmuxSupportTier(version);
	const clientCount = parseClientCount(rawClientCount);
	const paneActive = parseBoolean(rawPaneActive);
	const windowActive = parseBoolean(rawWindowActive);
	const clientTermname = rawClientTermname.trim();
	const widthPx = parsePositiveInteger(rawCellWidth);
	const heightPx = parsePositiveInteger(rawCellHeight);
	const cellDimensions = widthPx && heightPx ? { widthPx, heightPx } : undefined;

	return {
		kind: "tmux",
		version: version.trim(),
		supportTier,
		allowPassthrough: normalizeTmuxAllowPassthrough(rawAllow, supportTier),
		focusEvents: parseBoolean(rawFocusEvents),
		paneActive,
		windowActive,
		visible: paneActive && windowActive && clientCount === 1,
		clientCount,
		clientTermname,
		nested: isNestedClient(clientTermname),
		hyperlinks: rawTermfeatures
			.split(",")
			.map((feature) => feature.trim())
			.includes("hyperlinks"),
		...(cellDimensions ? { cellDimensions } : {}),
	};
}

export function probeTmuxImageState(
	env: Readonly<Record<string, string | undefined>> = process.env,
	execFile: TmuxExecFile = defaultExecFile,
): TmuxImageState {
	const term = env.TERM?.toLowerCase() ?? "";
	if (!env.TMUX && !term.startsWith("tmux")) {
		return { kind: "outside", ...DISABLED_STATE };
	}

	const pane = env.TMUX_PANE;
	const args = ["display-message", "-p"];
	if (pane && /^%\d+$/.test(pane)) {
		args.push("-t", pane);
	}
	args.push(TMUX_IMAGE_FORMAT);

	try {
		return parseTmuxImageState(execFile("tmux", args));
	} catch {
		return { kind: "unavailable", reason: "probe-failed", ...DISABLED_STATE };
	}
}
