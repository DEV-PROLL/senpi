import { renderCursorCliModelString, type Model, type ThinkingSelection } from "@earendil-works/pi-ai";

export function resolveCursorCliSpawnModel(
	model: Model<"cursor-agent">,
	selection: ThinkingSelection | undefined,
): string {
	return renderCursorCliModelString(model, selection);
}
