import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import {
	type AgentSessionLaunchProfile,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";

/** The immutable flags selected when a routing session is opened. */
export interface RpcSessionLaunchProfile extends AgentSessionLaunchProfile {
	sessionPath?: string;
}

export type SessionRuntime = Pick<AgentSessionRuntime, "session" | "dispose">;
export type RpcSessionState = "opening" | "open" | "closing" | "closed";

export interface RpcSessionEntry {
	state: RpcSessionState;
	runtime?: SessionRuntime;
	scope: ProviderScope;
	profile: Readonly<RpcSessionLaunchProfile>;
	durableSessionId?: string;
	sessionPath?: string;
	/** Canonical reservation key for path-opened sessions; matches the reservations set. */
	reservationKey?: string;
	/** Live attachments (open + later attaches). The runtime is disposed only when the last one closes. */
	attachments: number;
	lifecycleMutex: Promise<void>;
}

export class RpcSessionRegistryError extends Error {
	readonly code: "unknown_session" | "session_closing" | "session_path_in_use" | "invalid_path" | "open_failed";

	constructor(code: RpcSessionRegistryError["code"], reason?: string) {
		super(code === "open_failed" && reason ? `${code}: ${reason}` : code);
		this.code = code;
		this.name = "RpcSessionRegistryError";
	}
}

export interface RpcSessionRegistryOptions {
	agentDir: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
}

export interface OpenRpcSession {
	sessionId: string;
	durableSessionId: string;
	sessionPath?: string;
	/** True when this open attached to an already-open session instead of creating one. */
	attached?: boolean;
}

function canonicalPath(path: string): string {
	const absolutePath = resolve(path);
	if (existsSync(absolutePath)) return realpathSync(absolutePath);
	return `${realpathSync(dirname(absolutePath))}/${basename(absolutePath)}`;
}

function frozenProfile(profile: RpcSessionLaunchProfile): Readonly<RpcSessionLaunchProfile> {
	return Object.freeze({
		...profile,
		...(profile.creationModel ? { creationModel: Object.freeze({ ...profile.creationModel }) } : {}),
	});
}

/** Process-local lifecycle owner for multi-session RPC runtimes. */
export class RpcSessionRegistry {
	private readonly entries = new Map<string, RpcSessionEntry>();
	private readonly reservations = new Set<string>();
	private nextHandle = 0;
	private readonly options: RpcSessionRegistryOptions;

	constructor(options: RpcSessionRegistryOptions) {
		this.options = options;
	}

	async openSession(profile: RpcSessionLaunchProfile): Promise<OpenRpcSession> {
		this.validateProfile(profile);
		const sessionPath = profile.sessionPath ? canonicalPath(profile.sessionPath) : undefined;
		if (sessionPath && this.reservations.has(sessionPath)) {
			// Attach-on-open: a live session outlives individual client attachments, so a
			// resume (or a second surface) for an already-hosted path joins the existing
			// runtime instead of failing. Entries still opening or closing keep the
			// exclusive reservation and reject as before.
			const existing = [...this.entries].find(
				([, entry]) => entry.reservationKey === sessionPath && entry.state === "open",
			);
			if (!existing) throw new RpcSessionRegistryError("session_path_in_use");
			const [handle, entry] = existing;
			entry.attachments += 1;
			if (!entry.durableSessionId) throw new RpcSessionRegistryError("session_path_in_use");
			return { sessionId: handle, durableSessionId: entry.durableSessionId, sessionPath: entry.sessionPath, attached: true };
		}
		if (sessionPath) this.reservations.add(sessionPath);

		// Resume vs create parity (D1 + omo SenpiSessionRuntime.ts:198-200):
		// Create-only launch semantics mirror classic startup flags. A resumed
		// session restores its persisted model and thinking level instead of being
		// overridden by the new open_session request.
		const isResume = sessionPath !== undefined && existsSync(sessionPath);
		const storedProfile = frozenProfile({ ...profile, ...(sessionPath ? { sessionPath } : {}) });
		const runtimeProfile = isResume
			? frozenProfile({ ...storedProfile, creationModel: undefined, initialThinkingLevel: undefined })
			: storedProfile;

		const handle = `rpc-${++this.nextHandle}`;
		const entry: RpcSessionEntry = {
			state: "opening",
			scope: new ProviderScope(),
			profile: storedProfile,
			sessionPath,
			reservationKey: sessionPath,
			attachments: 1,
			lifecycleMutex: Promise.resolve(),
		};
		this.entries.set(handle, entry);
		try {
			const manager = sessionPath
				? SessionManager.open(sessionPath, undefined, storedProfile.cwd)
				: SessionManager.create(storedProfile.cwd);
			entry.runtime = await runWithProviderScope(entry.scope, () =>
				createAgentSessionRuntime(this.options.createRuntime, {
					cwd: manager.getCwd(),
					agentDir: this.options.agentDir,
					sessionManager: manager,
					launchProfile: runtimeProfile,
				}),
			);
			entry.durableSessionId = manager.getSessionId();
			entry.sessionPath ??= manager.getSessionFile();
			entry.state = "open";
			return { sessionId: handle, durableSessionId: entry.durableSessionId, sessionPath: entry.sessionPath };
		} catch (error) {
			// Runtime construction may have started extensions, watchers, and provider
			// registrations before it rejects. Keep the reservation and entry private
			// until all of those resources have been torn down, then release them as
			// one rollback so the path can immediately be opened again.
			try {
				await entry.runtime?.dispose();
			} catch {
				// The original construction error remains the externally visible cause.
			} finally {
				try {
					await entry.scope.close?.();
				} finally {
					this.entries.delete(handle);
					if (sessionPath) this.reservations.delete(sessionPath);
				}
			}
			if (error instanceof RpcSessionRegistryError) throw error;
			throw new RpcSessionRegistryError("open_failed", error instanceof Error ? error.message : undefined);
		}
	}

	getForCommand(handle: string, command: string): RpcSessionEntry {
		const entry = this.entries.get(handle);
		if (!entry) throw new RpcSessionRegistryError("unknown_session");
		if (entry.state === "closing" && !["abort", "abort_bash", "extension_ui_response"].includes(command)) {
			throw new RpcSessionRegistryError("session_closing");
		}
		if (entry.state !== "open" && entry.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
		return entry;
	}

	/**
	 * Starts a close synchronously. Call this before disposing any session-owned
	 * binding so a concurrent command cannot reach a half-disposed handler.
	 * Each call releases one attachment; the entry transitions to "closing" only
	 * when the last attachment closes, so callers must check the returned state
	 * and skip finalization while other attachments remain.
	 */
	beginClose(handle: string): RpcSessionEntry {
		const entry = this.entries.get(handle);
		if (entry?.state !== "open") throw new RpcSessionRegistryError("unknown_session");
		entry.attachments -= 1;
		if (entry.attachments > 0) return entry;
		entry.state = "closing";
		return entry;
	}

	async close(handle: string): Promise<void> {
		const entry = this.beginClose(handle);
		// Other attachments may still own the live session; only the last close finalizes.
		if (entry.state !== "closing") return;
		return this.closeMarked(handle);
	}

	/** Completes a close previously made visible by beginClose(). */
	async closeMarked(handle: string): Promise<void> {
		const entry = this.entries.get(handle);
		if (entry?.state !== "closing") throw new RpcSessionRegistryError("unknown_session");
		entry.lifecycleMutex = (async () => {
			try {
				await entry.runtime?.session.abort();
				await entry.runtime?.session.waitForIdle();
				await entry.runtime?.dispose();
				await entry.scope.close?.();
			} finally {
				entry.state = "closed";
				this.entries.delete(handle);
				if (entry.sessionPath) this.reservations.delete(entry.sessionPath);
			}
		})();
		return entry.lifecycleMutex;
	}

	list(): Array<{
		sessionId: string;
		durableSessionId?: string;
		sessionPath?: string;
		cwd: string;
		name?: string;
		status: RpcSessionState;
	}> {
		return [...this.entries].map(([sessionId, entry]) => ({
			sessionId,
			durableSessionId: entry.durableSessionId,
			sessionPath: entry.sessionPath,
			cwd: entry.profile.cwd,
			name: entry.runtime?.session.sessionManager.getSessionName(),
			status: entry.state,
		}));
	}

	private validateProfile(profile: RpcSessionLaunchProfile): void {
		if (!isAbsolute(profile.cwd) || (profile.sessionPath !== undefined && !isAbsolute(profile.sessionPath))) {
			throw new RpcSessionRegistryError("invalid_path");
		}
	}
}
