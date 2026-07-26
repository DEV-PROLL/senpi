/**
 * Builds the startup warning for recommended tmux settings.
 *
 * All missing settings are collected into a single message so users can fix
 * ~/.tmux.conf once, instead of discovering the recommendations one tmux
 * restart at a time.
 */

export interface TmuxSetupCheck {
	/** Value of `tmux show -gv extended-keys`. */
	extendedKeys?: string;
	/** Value of `tmux show -gv extended-keys-format`. */
	extendedKeysFormat?: string;
	/** Whether Kitty images are already flowing through tmux passthrough. */
	imagesEnabled: boolean;
	/** Whether the terminal hosting the tmux client can render Kitty graphics. */
	outerKittyCapable: boolean;
}

interface TmuxRecommendation {
	setting: string;
	reason: string;
}

export function buildTmuxSetupWarning(check: TmuxSetupCheck): string | undefined {
	const recommendations: TmuxRecommendation[] = [];

	if (check.extendedKeys !== "on" && check.extendedKeys !== "always") {
		recommendations.push({
			setting: "set -g extended-keys on",
			reason: "modified Enter keys (Shift+Enter, ...)",
		});
	}

	if (check.extendedKeysFormat === "xterm") {
		recommendations.push({
			setting: "set -g extended-keys-format csi-u",
			reason: "Pi works best with csi-u",
		});
	}

	// Only advertise passthrough when it would actually do something: images
	// are not already enabled and the outer terminal understands Kitty
	// graphics. Users who deliberately chose `allow-passthrough on` already
	// have working images and are not nagged to switch to `all`.
	if (!check.imagesEnabled && check.outerKittyCapable) {
		recommendations.push({
			setting: "set -g allow-passthrough all",
			reason: "inline images (Kitty graphics)",
		});
	}

	if (recommendations.length === 0) {
		return undefined;
	}

	const settingWidth = Math.max(...recommendations.map((entry) => entry.setting.length));
	const lines = recommendations.map((entry) => `  ${entry.setting.padEnd(settingWidth)}  # ${entry.reason}`);
	return `tmux is not fully configured. Add to ~/.tmux.conf and restart tmux:\n\n${lines.join("\n")}`;
}
