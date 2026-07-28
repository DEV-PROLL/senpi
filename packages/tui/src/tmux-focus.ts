export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

export interface TmuxFocusEvent {
	readonly event: "in" | "out" | null;
	readonly data: string;
}

export function consumeTmuxFocusEvent(data: string): TmuxFocusEvent {
	const focusIn = data.indexOf("\x1b[I");
	const focusOut = data.indexOf("\x1b[O");
	const index = focusIn === -1 ? focusOut : focusOut === -1 ? focusIn : Math.min(focusIn, focusOut);
	if (index === -1) return { event: null, data };

	return {
		event: index === focusIn ? "in" : "out",
		data: data.slice(0, index) + data.slice(index + 3),
	};
}
