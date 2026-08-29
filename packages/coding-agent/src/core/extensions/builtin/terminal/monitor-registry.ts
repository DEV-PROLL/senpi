import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import { describeExit } from "./tools/spawn.ts";

export interface MonitorLineEvent {
	readonly type: "line";
	readonly id: string;
	readonly description: string;
	readonly line: string;
}

export interface MonitorSummaryEvent {
	readonly type: "summary";
	readonly id: string;
	readonly description: string;
	readonly summary: string;
}

export type MonitorEvent = MonitorLineEvent | MonitorSummaryEvent;

export type MonitorRearmResult = "rearmed" | "not_paused" | "not_found";

export interface MonitorSnapshotEntry {
	readonly id: string;
	readonly description: string;
	readonly paused: boolean;
	/** Epoch milliseconds when the watch registered; feeds the footer's live elapsed label. */
	readonly startedAtMs: number;
}

export interface MonitorRegistryOptions {
	/** Observes every registry transition (register/pause/rearm/settle/dispose) with the live snapshot. */
	readonly onChange?: (snapshot: readonly MonitorSnapshotEntry[]) => void;
	/** Reserves one shared terminal capacity slot for a native watch. */
	readonly reserve?: () => (() => void) | null;
}

export interface RegisterFileMonitorOptions {
	readonly description: string;
	readonly path: string;
	readonly event: "create" | "modify";
	readonly timeoutMs: number;
	readonly cwd: string;
}

export interface RegisterMonitorOptions {
	readonly id: string;
	readonly description: string;
	readonly runtime: TerminalRuntimeSession;
	readonly filter?: RegExp;
}

interface FileMonitorRecord {
	readonly id: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly path: string;
	readonly event: "create" | "modify";
	readonly watcher: FSWatcher;
	readonly release: () => void;
	readonly poll: ReturnType<typeof setInterval>;
	paused: boolean;
	settled: boolean;
	present: boolean;
	mtimeMs: number;
	size: number;
	digest: string;
	pendingChange: boolean;
	dirty: boolean;
	dirtyPasses: number;
	dirtyWindowStartedAt: number;
	checking: Promise<void> | undefined;
	readonly deadline: ReturnType<typeof setTimeout>;
}

interface MonitorRecord {
	readonly id: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly runtime: TerminalRuntimeSession;
	readonly filter: RegExp | undefined;
	lineBuffer: string;
	paused: boolean;
	settled: boolean;
	unsubscribeOutput: (() => void) | undefined;
	unsubscribeExit: (() => void) | undefined;
}

/**
 * Tracks active monitor sessions alongside the terminal manager's existing bash-id registry.
 * Output is deliberately retained only by TerminalRuntimeSession's bounded history; this
 * registry holds at most one unfinished line for each live monitor.
 */
export class MonitorRegistry {
	readonly #records = new Map<string, MonitorRecord>();
	readonly #emit: (event: MonitorEvent) => void;
	readonly #onChange: ((snapshot: readonly MonitorSnapshotEntry[]) => void) | undefined;
	readonly #reserve: (() => (() => void) | null) | undefined;
	readonly #files = new Map<string, FileMonitorRecord>();
	#nextFileId = 1;
	#disposed = false;
	#pendingRegistrations = 0;
	#lifecycle = 0;

	constructor(emit: (event: MonitorEvent) => void, options?: MonitorRegistryOptions) {
		this.#emit = emit;
		this.#onChange = options?.onChange;
		this.#reserve = options?.reserve;
	}

	snapshot(): readonly MonitorSnapshotEntry[] {
		return [...this.#records.values(), ...this.#files.values()].map((record) => ({
			id: record.id,
			description: record.description,
			paused: record.paused,
			startedAtMs: record.startedAtMs,
		}));
	}

	async registerFile(options: RegisterFileMonitorOptions): Promise<string> {
		if (this.#disposed) throw new Error("Cannot create file monitor: monitor registry is disposed.");
		this.#pendingRegistrations += 1;
		const lifecycle = this.#lifecycle;
		const release = this.#reserve?.();
		if (this.#reserve && !release) {
			this.#pendingRegistrations -= 1;
			throw new Error("Cannot create file monitor: terminal capacity is already in use.");
		}
		const path = resolve(options.cwd, options.path);
		const parent = dirname(path);
		let approvedParent: string;
		try {
			await access(parent);
			approvedParent = await realpath(parent);
			if (this.#disposed) throw new Error("Cannot create file monitor: monitor registry is disposed.");
		} catch (error) {
			release?.();
			this.#pendingRegistrations -= 1;
			if (error instanceof Error && error.message.includes("disposed")) throw error;
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				throw new Error(
					`Cannot access parent directory ${parent}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			throw new Error(`Cannot watch file: parent directory does not exist: ${parent}`);
		}
		let initial: Awaited<ReturnType<typeof stat>> | null = null;
		try {
			initial = await stat(path);
			if (!initial.isFile()) throw new Error(`Cannot watch file: target is not a regular file: ${path}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				release?.();
				this.#pendingRegistrations -= 1;
				throw error;
			}
		}
		if (this.#disposed || lifecycle !== this.#lifecycle || this.#pendingRegistrations < 1) {
			release?.();
			this.#pendingRegistrations -= 1;
			throw new Error("Cannot create file monitor: monitor registry is disposed.");
		}
		const id = `watch_${this.#nextFileId++}`;
		let watcher: FSWatcher;
		try {
			const activationParent = await realpath(parent);
			if (activationParent !== approvedParent) {
				throw new Error(`Cannot watch file: parent directory changed during registration: ${parent}`);
			}
			watcher = watch(activationParent, (_kind, name) => {
				if (!name || basename(String(name)) === basename(path)) void this.#checkFile(id);
			});
		} catch (error) {
			release?.();
			this.#pendingRegistrations -= 1;
			throw new Error(`Cannot watch file ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		let registrationError: string | undefined;
		watcher.on("error", (error) => {
			registrationError = `watcher error: ${error instanceof Error ? error.message : String(error)}`;
			const record = this.#files.get(id);
			if (record) this.#settleFile(record, registrationError);
		});
		let registrationCleaned = false;
		const finishRegistration = () => {
			if (registrationCleaned) return;
			registrationCleaned = true;
			this.#pendingRegistrations -= 1;
		};
		const cleanupRegistration = () => {
			if (registrationCleaned) return;
			watcher.close();
			finishRegistration();
			release?.();
		};
		if (this.#disposed || lifecycle !== this.#lifecycle) {
			cleanupRegistration();
			throw new Error("Cannot create file monitor: monitor registry is disposed.");
		}
		let digest: string;
		try {
			digest = initial ? await this.#digest(path) : "";
		} catch (error) {
			cleanupRegistration();
			if (registrationError) {
				this.#emit({ type: "summary", id, description: options.description, summary: registrationError });
				throw new Error(registrationError);
			}
			throw error;
		}
		if (registrationError) {
			cleanupRegistration();
			this.#emit({ type: "summary", id, description: options.description, summary: registrationError });
			throw new Error(registrationError);
		}
		if (this.#disposed || lifecycle !== this.#lifecycle) {
			cleanupRegistration();
			throw new Error("Cannot create file monitor: monitor registry is disposed.");
		}
		const record: FileMonitorRecord = {
			id,
			description: options.description,
			startedAtMs: Date.now(),
			path,
			event: options.event,
			watcher,
			release: release ?? (() => {}),
			poll: setInterval(() => void this.#checkFile(id), 250),
			paused: false,
			settled: false,
			present: initial !== null,
			mtimeMs: initial?.mtimeMs ?? 0,
			size: initial?.size ?? 0,
			digest,
			pendingChange: false,
			dirty: false,
			dirtyPasses: 0,
			dirtyWindowStartedAt: 0,
			checking: undefined,
			deadline: setTimeout(() => {
				const current = this.#files.get(id);
				if (current) this.#settleFile(current, "watcher timed_out");
			}, options.timeoutMs),
		};
		this.#files.set(id, record);
		finishRegistration();
		if (registrationError || this.#disposed || lifecycle !== this.#lifecycle) {
			this.#settleFile(record, registrationError ?? "watcher killed");
			throw new Error(registrationError ?? "Cannot create file monitor: monitor registry is disposed.");
		}
		this.#notifyChange();
		return id;
	}

	async stopFile(id: string): Promise<boolean> {
		const record = this.#files.get(id);
		if (!record) return false;
		this.#settleFile(record, "watcher killed");
		return true;
	}

	async stopAllFiles(): Promise<number> {
		this.#lifecycle += 1;
		const records = [...this.#files.values()];
		for (const record of records) this.#settleFile(record, "watcher killed");
		return records.length;
	}

	#settleFile(record: FileMonitorRecord, summary: string): void {
		if (record.settled) return;
		record.settled = true;
		clearInterval(record.poll);
		clearTimeout(record.deadline);
		record.watcher.close();
		record.release();
		this.#files.delete(record.id);
		this.#notifyChange();
		this.#emit({ type: "summary", id: record.id, description: record.description, summary });
	}

	async #checkFile(id: string): Promise<void> {
		const record = this.#files.get(id);
		if (!record || record.settled) return;
		if (record.checking) {
			record.dirty = true;
			return;
		}
		record.checking = this.#checkFileImpl(record)
			.catch((error) => {
				if (!record.settled)
					this.#settleFile(record, `watcher error: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				record.checking = undefined;
				const now = Date.now();
				if (now - record.dirtyWindowStartedAt >= 1_000) {
					record.dirtyWindowStartedAt = now;
					record.dirtyPasses = 0;
				}
				if (record.dirty && !record.settled && record.dirtyPasses < 1) {
					record.dirty = false;
					record.dirtyPasses += 1;
					void this.#checkFile(id);
				} else {
					record.dirty = false;
				}
			});
		return record.checking;
	}

	async #checkFileImpl(record: FileMonitorRecord): Promise<void> {
		if (record.settled) return;
		let current: Awaited<ReturnType<typeof stat>> | null = null;
		try {
			current = await stat(record.path);
			if (!current.isFile()) throw new Error(`Cannot watch file: target is not a regular file: ${record.path}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				this.#settleFile(record, `watcher error: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		}
		const present = current !== null;
		const digest = present ? await this.#digest(record.path) : "";
		const changed =
			record.event === "create"
				? !record.present && present
				: record.present &&
					present &&
					(current!.mtimeMs !== record.mtimeMs || current!.size !== record.size || digest !== record.digest);
		record.pendingChange ||= changed;
		record.present = present;
		record.mtimeMs = current?.mtimeMs ?? 0;
		record.size = current?.size ?? 0;
		record.digest = digest;
		if (!record.pendingChange || record.paused || record.settled) return;
		record.pendingChange = false;
		if (record.settled) return;
		this.#emit({
			type: "line",
			id: record.id,
			description: record.description,
			line: `${record.event} ${record.path}`,
		});
		this.#settleFile(record, "watcher completed");
	}

	register(options: RegisterMonitorOptions): void {
		const record: MonitorRecord = {
			id: options.id,
			description: options.description,
			startedAtMs: Date.now(),
			runtime: options.runtime,
			filter: options.filter,
			lineBuffer: "",
			paused: false,
			settled: false,
			unsubscribeOutput: undefined,
			unsubscribeExit: undefined,
		};
		this.#records.set(record.id, record);
		this.#notifyChange();

		// Runtime output is already bounded. Read what was produced before monitor registration,
		// then subscribe synchronously so a fast watcher cannot lose its first line.
		this.#consume(record, record.runtime.fullOutput());
		record.unsubscribeOutput = record.runtime.onOutput((chunk) => this.#consume(record, chunk));
		record.unsubscribeExit = record.runtime.session.onExit(() => this.#settle(record));
		if (record.runtime.exited) this.#settle(record);
	}

	pauseAll(): string[] {
		const paused: string[] = [];
		for (const record of [...this.#records.values(), ...this.#files.values()]) {
			if (record.paused) continue;
			record.paused = true;
			paused.push(record.id);
		}
		if (paused.length > 0) this.#notifyChange();
		return paused;
	}

	rearm(id: string): MonitorRearmResult {
		const record = this.#records.get(id) ?? this.#files.get(id);
		if (!record) return "not_found";
		if (!record.paused) return "not_paused";
		record.paused = false;
		this.#notifyChange();
		if ("pendingChange" in record && record.pendingChange) void this.#checkFile(record.id);
		return "rearmed";
	}

	dispose(): void {
		this.#disposed = true;
		this.#lifecycle += 1;
		for (const record of this.#records.values()) this.#disposeRecord(record);
		for (const record of this.#files.values()) this.#settleFile(record, "watcher disposed");
		this.#records.clear();
		this.#notifyChange();
	}

	async #digest(path: string): Promise<string> {
		const SAMPLE_SIZE = 64 * 1024;
		try {
			const handle = await open(path, "r");
			try {
				const metadata = await handle.stat();
				const hash = createHash("sha256");
				const first = Buffer.alloc(Math.min(SAMPLE_SIZE, metadata.size));
				if (first.length > 0) {
					await handle.read(first, 0, first.length, 0);
					hash.update(first);
				}
				if (metadata.size > SAMPLE_SIZE) {
					const middle = Buffer.alloc(SAMPLE_SIZE);
					await handle.read(middle, 0, middle.length, Math.floor((metadata.size - middle.length) / 2));
					hash.update(middle);
					const last = Buffer.alloc(SAMPLE_SIZE);
					await handle.read(last, 0, last.length, metadata.size - last.length);
					hash.update(last);
				}
				return `${metadata.size}:${hash.digest("hex")}`;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
			throw error;
		}
	}

	#notifyChange(): void {
		this.#onChange?.(this.snapshot());
	}

	#consume(record: MonitorRecord, chunk: string): void {
		if (record.settled || chunk.length === 0) return;
		let remaining = record.lineBuffer + chunk;
		for (;;) {
			const newline = remaining.indexOf("\n");
			if (newline < 0) break;
			const rawLine = remaining.slice(0, newline);
			remaining = remaining.slice(newline + 1);
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (record.paused || (record.filter && !record.filter.test(line))) continue;
			this.#emit({ type: "line", id: record.id, description: record.description, line });
		}
		record.lineBuffer = remaining;
	}

	#settle(record: MonitorRecord): void {
		if (record.settled) return;
		record.settled = true;
		record.unsubscribeOutput?.();
		record.unsubscribeExit?.();
		this.#records.delete(record.id);
		this.#notifyChange();
		const status = describeExit(record.runtime) ?? "exited";
		const code = record.runtime.exitResult?.exitCode;
		const codeText = code === null || code === undefined ? "" : ` (exit code ${code})`;
		this.#emit({
			type: "summary",
			id: record.id,
			description: record.description,
			summary: `watcher ${status}${codeText}`,
		});
	}

	#disposeRecord(record: MonitorRecord): void {
		record.settled = true;
		record.unsubscribeOutput?.();
		record.unsubscribeExit?.();
	}
}
