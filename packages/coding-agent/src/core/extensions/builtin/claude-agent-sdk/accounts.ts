import type { Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";

export type AccountSlot = {
	name: string;
	refresh: string;
	access: string;
	expires: number;
	source: "login" | "import" | "env";
	blockedUntil?: number;
	blockReason?: string;
};

export type SlotState = Record<string, { blockedUntil?: number; blockReason?: string }>;

export type ClaudeAgentSdkCredential = OAuthCredential & {
	accounts?: AccountSlot[];
	pinned?: string;
	slotState?: SlotState;
};

export const SENTINEL_OAUTH_FIELDS = {
	access: "claude-agent-sdk-managed",
	refresh: "claude-agent-sdk-managed",
	expires: 4102444800000,
} as const;

export function emptyCredential(): ClaudeAgentSdkCredential {
	return { type: "oauth", ...SENTINEL_OAUTH_FIELDS, accounts: [] };
}

function storedSlots(credential: ClaudeAgentSdkCredential): AccountSlot[] {
	return credential.accounts ?? [];
}

export function listAccounts(
	credential: ClaudeAgentSdkCredential,
	env?: (name: string) => string | undefined,
): AccountSlot[] {
	const slots = [...storedSlots(credential)];
	if (env) {
		const state = credential.slotState ?? {};
		for (const slot of envSlots(env)) {
			const persisted = state[slot.name];
			slots.push(persisted ? { ...slot, ...persisted } : slot);
		}
	}
	return slots;
}

export function addAccount(credential: ClaudeAgentSdkCredential, slot: AccountSlot): ClaudeAgentSdkCredential {
	if (storedSlots(credential).some((existing) => existing.name === slot.name)) {
		throw new Error(`Account '${slot.name}' already exists`);
	}
	return { ...credential, accounts: [...storedSlots(credential), slot] };
}

export function removeAccount(credential: ClaudeAgentSdkCredential, name: string): ClaudeAgentSdkCredential {
	const accounts = storedSlots(credential).filter((slot) => slot.name !== name);
	const next: ClaudeAgentSdkCredential = { ...credential, accounts };
	if (credential.pinned === name) delete next.pinned;
	return next;
}

export function pinAccount(credential: ClaudeAgentSdkCredential, name: string): ClaudeAgentSdkCredential {
	return { ...credential, pinned: name };
}

export function assertSentinelInvariant(credential: ClaudeAgentSdkCredential): void {
	if (
		credential.access !== SENTINEL_OAUTH_FIELDS.access ||
		credential.refresh !== SENTINEL_OAUTH_FIELDS.refresh ||
		credential.expires !== SENTINEL_OAUTH_FIELDS.expires
	) {
		throw new Error("top-level OAuth fields must remain sentinel values");
	}
}

export function envSlots(env: (name: string) => string | undefined): AccountSlot[] {
	const slots: AccountSlot[] = [];
	const read = (suffix: string | undefined) =>
		env(suffix === undefined ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${suffix}`);
	const names: Array<{ suffix?: string; slot: string }> = [{ slot: "env" }];
	for (let index = 2; index <= 16; index++) names.push({ suffix: String(index), slot: `env-${index}` });
	for (const { suffix, slot } of names) {
		const token = read(suffix);
		if (token) {
			slots.push({ name: slot, refresh: "", access: "", expires: 0, source: "env" });
		}
	}
	return slots;
}

export function envSlotToken(env: (name: string) => string | undefined, slotName: string): string | undefined {
	const match = /^env(?:-(\d+))?$/.exec(slotName);
	if (!match) return undefined;
	const suffix = match[1];
	return env(suffix === undefined ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${suffix}`);
}

export type SlotRefresher = (refreshToken: string) => Promise<{ refresh: string; access: string; expires: number }>;
export type SlotExpirationCheck = (expires: number) => boolean;

export async function refreshSlot(
	store: CredentialStore,
	providerId: string,
	slotName: string,
	refresher: SlotRefresher,
	isExpiring: SlotExpirationCheck = (expires) => Date.now() >= expires,
): Promise<Credential | undefined> {
	return store.modify(providerId, async (current) => {
		if (current?.type !== "oauth") return undefined;
		const credential = current as ClaudeAgentSdkCredential;
		const slot = storedSlots(credential).find((candidate) => candidate.name === slotName);
		if (!slot) return current;
		if (!isExpiring(slot.expires)) return current;
		const refreshed = await refresher(slot.refresh);
		const accounts = storedSlots(credential).map((candidate) =>
			candidate.name === slotName
				? { ...candidate, refresh: refreshed.refresh, access: refreshed.access, expires: refreshed.expires }
				: candidate,
		);
		return { ...credential, accounts };
	});
}
