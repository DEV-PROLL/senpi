/** Compatibility entry point for coding-agent extension OAuth declarations. */
export { loadAnthropicOAuth, registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
