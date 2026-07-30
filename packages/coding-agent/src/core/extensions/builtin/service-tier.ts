import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../model-registry.ts";
import { SettingsManager } from "../../settings-manager.ts";
import type { ExtensionAPI, ServiceTier } from "../types.ts";

export type { ServiceTier };

type ProviderPayload = Record<string, unknown>;

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const FAST_MODEL_SUFFIX = "-fast";
/**
 * `/fast` is registered only for `openai-codex`, but the catalog generator emits
 * `-fast` priority variants only for the direct `openai` provider, so no Codex
 * model ever has a target and the command could only report "not supported".
 *
 * That gap is intentional rather than an oversight in the generator: measured
 * against `chatgpt.com/backend-api/codex/responses` with a live ChatGPT Pro
 * subscription, `service_tier: "priority"` returns HTTP 200 but the response
 * echoes `"auto"`, while `"auto"`/`"flex"`/`"scale"` are rejected with HTTP 400
 * `Unsupported service_tier`. Priority processing is an API-billing feature, so
 * a subscription request is served at normal tier no matter what is sent — and
 * `getServiceTierCostMultiplier()` would still bill it at up to 2.5x.
 *
 * So the honest answer is that fast mode is unavailable here, not that the
 * model does not support it.
 */
const FAST_UNAVAILABLE_ON_SUBSCRIPTION =
	"Fast mode (priority tier) is not available on a ChatGPT subscription: chatgpt.com accepts " +
	"service_tier=priority but serves the request at normal tier. Priority processing requires " +
	"API-key billing on the `openai` provider.";
const SERVICE_TIER_APIS: ReadonlySet<Api> = new Set(["openai-responses", OPENAI_CODEX_RESPONSES_API]);

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

function getRequestModelId(modelRegistry: ModelRegistry, model: Model<Api>): string {
	return modelRegistry.getUpstreamModelId(model) ?? model.id;
}

function isCompatibleFastVariant(modelRegistry: ModelRegistry, baseModel: Model<Api>, fastModel: Model<Api>): boolean {
	return (
		fastModel.provider === baseModel.provider &&
		fastModel.api === baseModel.api &&
		modelRegistry.getServiceTier(fastModel) === "priority" &&
		getRequestModelId(modelRegistry, fastModel) === getRequestModelId(modelRegistry, baseModel)
	);
}

function findBaseModel(modelRegistry: ModelRegistry, fastModel: Model<Api>): Model<Api> | undefined {
	if (!fastModel.id.endsWith(FAST_MODEL_SUFFIX)) {
		return undefined;
	}

	const baseModelId = fastModel.id.slice(0, -FAST_MODEL_SUFFIX.length);
	const baseModel = modelRegistry.find(fastModel.provider, baseModelId);
	return baseModel && isCompatibleFastVariant(modelRegistry, baseModel, fastModel) ? baseModel : undefined;
}

function findFastModel(modelRegistry: ModelRegistry, baseModel: Model<Api>): Model<Api> | undefined {
	if (baseModel.id.endsWith(FAST_MODEL_SUFFIX)) {
		return undefined;
	}

	const fastModel = modelRegistry.find(baseModel.provider, `${baseModel.id}${FAST_MODEL_SUFFIX}`);
	return fastModel && isCompatibleFastVariant(modelRegistry, baseModel, fastModel) ? fastModel : undefined;
}

export default function serviceTierExtension(pi: ExtensionAPI): void {
	let settingsServiceTier: ServiceTier | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const settingsManager = SettingsManager.create(ctx.cwd);
		settingsServiceTier = settingsManager.getOpenAIServiceTier();

		const model = ctx.model;
		if (model?.provider !== OPENAI_CODEX_PROVIDER) {
			return;
		}

		const baseModel = findBaseModel(ctx.modelRegistry, model);
		if (baseModel) {
			await pi.setSessionModel(baseModel);
		}
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex fast mode for this session",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (model?.provider !== OPENAI_CODEX_PROVIDER) {
				ctx.ui.notify("Fast mode is only available for OpenAI Codex models.", "warning");
				return;
			}

			const baseModel = findBaseModel(ctx.modelRegistry, model);
			const targetModel = baseModel ?? findFastModel(ctx.modelRegistry, model);
			if (!targetModel) {
				ctx.ui.notify(FAST_UNAVAILABLE_ON_SUBSCRIPTION, "warning");
				return;
			}

			if (!(await pi.setSessionModel(targetModel))) {
				ctx.ui.notify(`Could not switch to ${targetModel.provider}/${targetModel.id}.`, "error");
				return;
			}

			const enabled = baseModel === undefined;
			ctx.ui.notify(`Fast mode ${enabled ? "enabled" : "disabled"}: ${targetModel.id}`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const effectiveServiceTier =
			ctx.model?.api === OPENAI_CODEX_RESPONSES_API ? ctx.serviceTier : (ctx.serviceTier ?? settingsServiceTier);
		return addServiceTierToPayload(ctx.model?.api, event.payload, effectiveServiceTier);
	});
}
