import type { Credential, CredentialInfo, CredentialStore, OAuthAuth } from "@earendil-works/pi-ai";

type ExtensionOAuthRegistry = {
	registerOAuthProvider(providerId: string, oauth: OAuthAuth): void;
	unregisterOAuthProvider(providerId: string): void;
};

function asExtensionOAuthRegistry(store: CredentialStore): ExtensionOAuthRegistry | undefined {
	const candidate = store as CredentialStore & Partial<ExtensionOAuthRegistry>;
	return typeof candidate.registerOAuthProvider === "function" &&
		typeof candidate.unregisterOAuthProvider === "function"
		? (candidate as ExtensionOAuthRegistry)
		: undefined;
}

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	registerOAuthProvider(providerId: string, oauth: OAuthAuth): void {
		asExtensionOAuthRegistry(this.store)?.registerOAuthProvider(providerId, oauth);
	}

	unregisterOAuthProvider(providerId: string): void {
		asExtensionOAuthRegistry(this.store)?.unregisterOAuthProvider(providerId);
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list()).map((entry) => [entry.providerId, entry]));
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn);
	}

	async delete(providerId: string): Promise<void> {
		this.overrides.delete(providerId);
		await this.store.delete(providerId);
	}
}
