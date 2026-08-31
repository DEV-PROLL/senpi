import { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";

export interface OwnershipSafeLockOptions {
	readonly retries?: {
		readonly retries: number;
		readonly minTimeout: number;
		readonly maxTimeout: number;
	};
}

export class LegacyLockArtifactError extends Error {
	readonly code = "ELEGACY_LOCK_ARTIFACT" as const;
	readonly lockPath: string;

	constructor(lockPath: string) {
		super(`Legacy lock directory is present at ${lockPath}`);
		this.name = "LegacyLockArtifactError";
		this.lockPath = lockPath;
	}
}

const DEFAULT_RETRIES = { retries: 100, minTimeout: 20, maxTimeout: 100 } as const;

export async function acquireOwnershipSafeLock(
	lockPath: string,
	options: OwnershipSafeLockOptions = {},
): Promise<() => Promise<void>> {
	await rejectLegacyDirectory(lockPath);
	const retries = options.retries ?? DEFAULT_RETRIES;
	const busyTimeout = Math.max(retries.minTimeout, retries.maxTimeout);
	let attempt = 0;
	while (true) {
		await rejectLegacyDirectory(lockPath);
		let database: Database | undefined;
		try {
			database = new Database(lockPath, { create: true });
			database.exec(`PRAGMA busy_timeout = ${busyTimeout}; BEGIN EXCLUSIVE;`);
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				try {
					database!.exec("COMMIT;");
				} finally {
					database!.close();
				}
			};
		} catch (error: unknown) {
			if (database) database.close(false);
			if (isBusy(error) && attempt++ < retries.retries) {
				await new Promise((resolve) =>
					setTimeout(resolve, Math.min(retries.maxTimeout, retries.minTimeout * 2 ** Math.min(attempt, 6))),
				);
				continue;
			}
			throw error;
		}
	}
}

async function rejectLegacyDirectory(lockPath: string): Promise<void> {
	try {
		if ((await stat(lockPath)).isDirectory()) throw new LegacyLockArtifactError(lockPath);
	} catch (error: unknown) {
		if (error instanceof LegacyLockArtifactError || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function isBusy(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /busy|locked/i.test(message) || (error as { code?: string })?.code === "SQLITE_BUSY";
}
