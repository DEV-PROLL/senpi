import { lazyOAuth } from "../auth/helpers.ts";
import { loadCursorOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";

/**
 * Cursor subscription provider (OAuth only).
 *
 * Cursor chat runs on a protobuf Connect-RPC agent protocol
 * (`agent.v1.AgentService` on `api2.cursor.sh`) that is not ported yet, so
 * the provider ships with no models and no wire implementation: nothing is
 * selectable in model pickers, and a hypothetical stream dispatch fails with
 * createProvider's built-in "no API implementation" error. Login, token
 * refresh, and credential storage are fully functional today, and the stored
 * access token resolves through the standard auth pipeline for extensions
 * that speak the Cursor protocol.
 */
export function cursorProvider(): Provider {
	return createProvider({
		id: "cursor",
		name: "Cursor",
		auth: {
			oauth: lazyOAuth({
				name: "Cursor (Pro/Ultra/Teams)",
				isSubscription: true,
				loginLabel: "Sign in with Cursor",
				load: loadCursorOAuth,
			}),
		},
		models: [],
		api: {},
	});
}
