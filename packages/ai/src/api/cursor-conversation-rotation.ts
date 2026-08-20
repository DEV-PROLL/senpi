import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_CURSOR_CONVERSATION_ROTATIONS = 3;
export const CURSOR_CONVERSATION_POISONED_MESSAGE =
	"Cursor conversation is poisoned for this session; use another provider";

const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/i;

export type ConversationRotationRecord = {
	readonly wireId: string;
	readonly poisonCount: number;
	readonly skip: boolean;
};

export type PoisonDecision =
	| { readonly kind: "rotated"; readonly wireId: string }
	| { readonly kind: "exhausted" };

type MutableRecord = {
	wireId: string;
	poisonCount: number;
	skip: boolean;
};

export type ConversationRotationStore = {
	getWireId(baseId: string): string;
	shouldSkip(baseId: string): boolean;
	recordZeroTokenPoison(baseId: string, currentWireId: string): PoisonDecision;
};

export function isZeroTokenResourceExhausted(errorMessage: string, sawTokenDelta: boolean): boolean {
	return !sawTokenDelta && RESOURCE_EXHAUSTED_PATTERN.test(errorMessage);
}

export function createConversationRotationStore(options: {
	readonly persistPath: string;
	readonly randomId?: () => string;
}): ConversationRotationStore {
	const randomId = options.randomId ?? randomUUID;
	const records = loadRecords(options.persistPath);

	const persist = (): void => {
		mkdirSync(dirname(options.persistPath), { recursive: true });
		writeFileSync(options.persistPath, `${JSON.stringify(records, null, 2)}\n`);
	};

	return {
		getWireId(baseId: string): string {
			const existing = records[baseId];
			if (!existing) return baseId;
			if (!existing.skip) return existing.wireId;
			const wireId = randomId();
			existing.wireId = wireId;
			existing.skip = false;
			existing.poisonCount = 0;
			records[baseId] = existing;
			persist();
			return wireId;
		},
		shouldSkip(baseId: string): boolean {
			return records[baseId]?.skip === true;
		},
		recordZeroTokenPoison(baseId: string, currentWireId: string): PoisonDecision {
			const existing = records[baseId] ?? {
				wireId: currentWireId,
				poisonCount: 0,
				skip: false,
			};
			if (existing.skip || existing.poisonCount >= MAX_CURSOR_CONVERSATION_ROTATIONS) {
				existing.skip = true;
				existing.wireId = currentWireId;
				records[baseId] = existing;
				persist();
				return { kind: "exhausted" };
			}
			const wireId = randomId();
			existing.wireId = wireId;
			existing.poisonCount += 1;
			records[baseId] = existing;
			persist();
			return { kind: "rotated", wireId };
		},
	};
}

export function resolveConversationRotationPersistPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.CURSOR_CONVERSATION_ID_STORE) {
		return env.CURSOR_CONVERSATION_ID_STORE;
	}
	const agentDir = env.SENPI_CODING_AGENT_DIR ?? env.HOME ?? ".";
	return `${agentDir.replace(/\/$/, "")}/cursor-conversation-ids.json`;
}

function loadRecords(persistPath: string): Record<string, MutableRecord> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(persistPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const records: Record<string, MutableRecord> = {};
		for (const [baseId, value] of Object.entries(parsed)) {
			if (!value || typeof value !== "object") continue;
			const raw = value as { wireId?: unknown; poisonCount?: unknown; skip?: unknown };
			if (typeof raw.wireId !== "string" || raw.wireId.length === 0) continue;
			records[baseId] = {
				wireId: raw.wireId,
				poisonCount: typeof raw.poisonCount === "number" && raw.poisonCount >= 0 ? raw.poisonCount : 0,
				skip: raw.skip === true,
			};
		}
		return records;
	} catch {
		return {};
	}
}
