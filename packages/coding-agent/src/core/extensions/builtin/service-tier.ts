import type { Api } from "@earendil-works/pi-ai";
import { SettingsManager } from "../../settings-manager.ts";
import type { ExtensionAPI, ServiceTier } from "../types.ts";

export type { ServiceTier };

type ProviderPayload = Record<string, unknown>;

const SERVICE_TIER_APIS: ReadonlySet<Api> = new Set(["openai-responses"]);

function isRecord(value: unknown): value is ProviderPayload {
	return typeof value === "object" && value !== null;
}

export function addServiceTierToPayload(api: Api | undefined, payload: unknown, serviceTier?: ServiceTier): unknown {
	if (!api || !SERVICE_TIER_APIS.has(api) || !serviceTier) {
		return payload;
	}

	if (!isRecord(payload) || payload.service_tier !== undefined) {
		return payload;
	}

	return {
		...payload,
		service_tier: serviceTier,
	};
}

export default function serviceTierExtension(pi: ExtensionAPI): void {
	let settingsServiceTier: ServiceTier | undefined;
	let codexFastMode = false;

	pi.on("session_start", async (_event, ctx) => {
		const settingsManager = SettingsManager.create(ctx.cwd);
		settingsServiceTier = settingsManager.getOpenAIServiceTier();
		codexFastMode = false;
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex fast mode for this session",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== "openai-codex" || ctx.model.api !== "openai-codex-responses") {
				ctx.ui.notify("Fast mode is only available for OpenAI Codex models.", "error");
				return;
			}

			codexFastMode = !codexFastMode;
			ctx.ui.notify(`Fast mode: ${codexFastMode ? "priority" : "default"}`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (
			ctx.model?.provider === "openai-codex" &&
			ctx.model.api === "openai-codex-responses" &&
			isRecord(event.payload)
		) {
			const payload = { ...event.payload };
			if (codexFastMode) {
				payload.service_tier = "priority";
			} else {
				delete payload.service_tier;
			}
			return payload;
		}

		const effectiveServiceTier = ctx.serviceTier ?? settingsServiceTier;
		return addServiceTierToPayload(ctx.model?.api, event.payload, effectiveServiceTier);
	});
}
