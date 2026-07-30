import { hasCredentialHeaders, hasHeader } from "../auth/headers.ts";
import type { ProviderHeaders } from "../types.ts";

export interface OpenAIClientAuth {
	apiKey: string;
	headers?: ProviderHeaders;
}

export function resolveOpenAIClientAuth(
	provider: string,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): OpenAIClientAuth {
	if (apiKey) return { apiKey, headers };
	if (!hasCredentialHeaders(headers)) throw new Error(`No API key for provider: ${provider}`);
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) {
		return { apiKey: "unused", headers };
	}
	return {
		apiKey: "unused",
		headers: { Authorization: null, ...headers },
	};
}
