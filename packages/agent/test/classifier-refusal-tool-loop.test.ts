import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/index.ts";
import { calculateTool } from "./utils/calculate.ts";

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];
const anthropicPolicyRefusal =
	"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.";

afterEach(() => {
	vi.restoreAllMocks();
	for (const registration of registrations.splice(0)) registration.unregister();
});

describe("classifier refusal tool-loop termination", () => {
	it("ends the agent turn without executing a refused tool call", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage([fauxToolCall("calculate", { expression: "123 * 456" }, { id: "refused-tool" })], {
				stopReason: "toolUse",
				errorMessage: anthropicPolicyRefusal,
				stopDetails: { type: "refusal", explanation: anthropicPolicyRefusal },
			}),
			fauxAssistantMessage("The primary model continued after the refusal."),
		]);
		const execute = vi.spyOn(calculateTool, "execute");
		const agent = new Agent({
			streamFn: streamSimple,
			initialState: {
				systemPrompt: "Use the calculator when requested.",
				model: registration.getModel(),
				thinkingLevel: "off",
				tools: [calculateTool],
			},
		});

		await agent.prompt("Calculate 123 * 456.");

		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toMatchObject({
			role: "assistant",
			stopReason: "toolUse",
			stopDetails: { type: "refusal" },
		});
	});
});
