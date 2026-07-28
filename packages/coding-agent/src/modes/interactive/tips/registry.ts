import { CLI_TIPS } from "./catalog/cli-tips.ts";
import { INPUT_TIPS } from "./catalog/input-tips.ts";
import { MODEL_TIPS } from "./catalog/model-tips.ts";
import { SESSION_TIPS } from "./catalog/session-tips.ts";
import { SETTINGS_TIPS } from "./catalog/settings-tips.ts";
import { SUBAGENT_TIPS } from "./catalog/subagent-tips.ts";
import type { TipDefinition } from "./catalog/types.ts";
import { WORKSPACE_TIPS } from "./catalog/workspace-tips.ts";

export type { TipDefinition } from "./catalog/types.ts";

export const TIP_DEFINITIONS: readonly TipDefinition[] = [
	...MODEL_TIPS,
	...INPUT_TIPS,
	...SESSION_TIPS,
	...WORKSPACE_TIPS,
	...SETTINGS_TIPS,
	...CLI_TIPS,
	...SUBAGENT_TIPS,
];
