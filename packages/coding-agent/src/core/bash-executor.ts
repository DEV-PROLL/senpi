/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputChunkStart = 0;
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let tempFileError: Error | undefined;
	let totalBytes = 0;

	const compactOutputChunks = () => {
		if (outputChunkStart < 64) {
			return;
		}
		outputChunks.splice(0, outputChunkStart);
		outputChunkStart = 0;
	};

	const outputText = () => outputChunks.slice(outputChunkStart).join("");

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
		tempFileStream = createWriteStream(tempFilePath);
		tempFileStream.on("error", (error) => {
			tempFileError ??= error;
		});
		for (let i = outputChunkStart; i < outputChunks.length; i++) {
			const chunk = outputChunks[i];
			if (chunk !== undefined) {
				tempFileStream.write(chunk);
			}
		}
	};

	const closeTempFileStream = async () => {
		const stream = tempFileStream;
		tempFileStream = undefined;
		if (!stream) {
			return;
		}
		if (tempFileError) {
			await new Promise<void>((resolve) => {
				if (stream.closed) {
					resolve();
					return;
				}
				stream.once("close", resolve);
				stream.destroy();
			});
			throw tempFileError;
		}

		await new Promise<void>((resolve, reject) => {
			let finished = false;
			let closed = false;
			let streamError: Error | undefined;
			const settle = () => {
				if (!closed) {
					return;
				}
				stream.off("finish", onFinish);
				stream.off("error", onError);
				stream.off("close", onClose);
				if (streamError) {
					reject(streamError);
				} else if (finished) {
					resolve();
				} else {
					reject(new Error("Bash spill stream closed before finish"));
				}
			};
			const onError = (error: Error) => {
				streamError ??= error;
			};
			const onFinish = () => {
				finished = true;
			};
			const onClose = () => {
				closed = true;
				if (!finished && !stream.destroyed) {
					stream.destroy();
				}
				settle();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.once("close", onClose);
			stream.end();
		});
	};

	const removeTempFile = async (): Promise<void> => {
		if (!tempFilePath) {
			return;
		}
		const path = tempFilePath;
		tempFilePath = undefined;
		await rm(path, { force: true });
	};

	const closeTempFileAndCleanup = async (primaryError: unknown): Promise<never> => {
		let finalError = primaryError;
		try {
			await closeTempFileStream();
		} catch (closeError) {
			if (!(closeError instanceof Error)) throw closeError;
			finalError = new AggregateError([primaryError, closeError], "Bash output cleanup failed");
		}
		try {
			await removeTempFile();
		} catch (unlinkError) {
			if (!(unlinkError instanceof Error)) throw unlinkError;
			finalError = new AggregateError([finalError, unlinkError], "Bash output cleanup failed");
		}
		throw finalError;
	};

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunkStart < outputChunks.length - 1) {
			const removed = outputChunks[outputChunkStart];
			if (removed === undefined) {
				break;
			}
			outputBytes -= removed.length;
			outputChunkStart++;
		}
		compactOutputChunks();

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	const finishDecoder = () => {
		const finalText = sanitizeBinaryOutput(stripAnsi(decoder.decode())).replace(/\r/g, "");
		if (finalText.length > 0) {
			onData(Buffer.from(finalText, "utf-8"));
		}
	};

	const prepareFinalOutput = async () => {
		try {
			finishDecoder();
			const fullOutput = outputText();
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			return { fullOutput, truncationResult };
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			return await closeTempFileAndCleanup(error);
		}
	};

	let result: Awaited<ReturnType<BashOperations["exec"]>>;
	try {
		result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});
	} catch (err) {
		if (!(err instanceof Error)) throw err;
		// Check if it was an abort
		if (options?.signal?.aborted) {
			const { fullOutput, truncationResult } = await prepareFinalOutput();
			try {
				await closeTempFileStream();
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				return await closeTempFileAndCleanup(error);
			}
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		return await closeTempFileAndCleanup(err);
	}

	const { fullOutput, truncationResult } = await prepareFinalOutput();
	try {
		await closeTempFileStream();
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return await closeTempFileAndCleanup(error);
	}
	const cancelled = options?.signal?.aborted ?? false;

	return {
		output: truncationResult.truncated ? truncationResult.content : fullOutput,
		exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
		cancelled,
		truncated: truncationResult.truncated,
		fullOutputPath: tempFilePath,
	};
}
