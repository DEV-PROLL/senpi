/**
 * Worker half of claude-sdk-oauth-reattach-spike.mjs.
 *
 * Runs one streaming-input query (optionally with `resume: <sessionId>` and/or
 * an env-scoped CLAUDE_CONFIG_DIR), plays the requested prompts, and reports
 * the session id, coherence, and prompt-cache usage back to the supervisor.
 * Runs inside a forked child so "resume after the owning process exited" is a
 * real process death, not a closed handle.
 */

import { randomUUID } from "node:crypto";
import {
	assistantText,
	claudeExecutable,
	closeQuietly,
	controlledInput,
	importClaudeSdk,
	managedEnvironment,
	userMessage,
	withTimeout,
} from "./claude-sdk-oauth-spike-support.mjs";

export const TOKEN_PROMPT = (token) => `Remember this token for later: ${token}. Reply with exactly: ACK`;

function readUsage(message) {
	const usage = message?.usage ?? message?.message?.usage;
	if (!usage) return undefined;
	return {
		input: usage.input_tokens ?? 0,
		cacheRead: usage.cache_read_input_tokens ?? 0,
		cacheCreation: usage.cache_creation_input_tokens ?? 0,
	};
}

/** Static read of a session transcript under whatever config root this process has. */
async function staticRead(sessionId) {
	const sdk = await importClaudeSdk();
	try {
		const info = await sdk.getSessionInfo(sessionId);
		const messages = await sdk.getSessionMessages(sessionId, { includeSystemMessages: true });
		return { found: info !== undefined || messages.length > 0 };
	} catch (error) {
		// A read FAILURE (SDK method missing, permission denied, malformed
		// response) is not evidence of absence — report it separately so the
		// config-root verdict cannot mistake an infrastructure error for
		// "not found under this root".
		return { found: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * @param {{access: string, prompts?: string[], resume?: string, configDir?: string,
 *          expectToken?: string, staticRead?: string, staticOnly?: boolean}} request
 */
export async function runTurns(request) {
	const result = { sessionId: null, coherent: false, usage: undefined };
	// An absent configDir must mean the SDK DEFAULT root: an operator-set
	// CLAUDE_CONFIG_DIR inherited from the spike's shell would silently
	// re-address the "default-root" reads and corrupt the config-root verdict.
	if (request.configDir) process.env.CLAUDE_CONFIG_DIR = request.configDir;
	else delete process.env.CLAUDE_CONFIG_DIR;
	if (request.staticRead) {
		const read = await staticRead(request.staticRead);
		result.staticFound = read.found;
		if (read.error) result.staticError = read.error;
	}
	// A static-only probe answers "is this session visible under this config
	// root?" without spawning Claude Code or spending quota at all.
	if (request.staticOnly) {
		result.coherent = true;
		return result;
	}

	const { query } = await importClaudeSdk();
	const prompts = [...request.prompts];
	// Count BEFORE the initial shift: every requested prompt — including the
	// first — must reach a successful terminal result for the run to be whole.
	const expectedTurns = prompts.length;
	const input = controlledInput(userMessage(prompts.shift(), randomUUID()));
	const options = {
		model: "claude-haiku-4-5",
		tools: [],
		permissionMode: "dontAsk",
		settingSources: [],
		systemPrompt: "Answer briefly. Obey the exact reply format the user asks for.",
		pathToClaudeCodeExecutable: claudeExecutable(),
		env: managedEnvironment(request.access, request.configDir ? { CLAUDE_CONFIG_DIR: request.configDir } : {}),
	};
	if (request.resume) options.resume = request.resume;
	const stream = query({ prompt: input, options });
	let completedTurns = 0;

	const drain = (async () => {
		for await (const message of stream) {
			if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
				result.sessionId ??= message.session_id;
			}
			if (message.type === "assistant") {
				// An assistant-level SDK failure must fail the turn, not pass
				// through as usage/coherence evidence.
				if (message.error) throw new Error("assistant_error");
				if (message.message?.model === "<synthetic>") throw new Error("synthetic_assistant");
				// Pass the whole message: usage can live on the assistant envelope OR
				// directly on the message (result shape) — nested-only reads silently
				// fall back to a 0.00 cache ratio.
				result.usage = readUsage(message) ?? result.usage;
				if (request.expectToken && assistantText(message).includes(request.expectToken)) result.coherent = true;
			}
			if (message.type === "auth_status" && message.error) throw new Error("authentication_failed");
			if (message.type !== "result") continue;
			// Result envelopes can carry usage directly — record before the gates.
			result.usage = readUsage(message) ?? result.usage;
			// A 401/refusal arrives as subtype:"success" with is_error:true; that
			// shape on a resume IS the addressing/auth denial (resume_failed).
			// Any other non-success (quota, refusal, content filter) is a
			// turn-level error and must NOT be folded into the denial signal.
			if (message.subtype !== "success" || message.is_error === true) {
				const reason =
					message.is_error === true && message.subtype === "success"
						? "result_error"
						: (message.subtype ?? "result_error");
				if (request.resume) {
					throw new Error(message.is_error === true ? "resume_failed" : `resume_error_${reason}`);
				}
				throw new Error(reason);
			}
			completedTurns += 1;
			if (prompts.length === 0) break;
			input.push(userMessage(prompts.shift(), randomUUID()));
		}
		// An iterator that ends before every requested prompt completed its
		// terminal result means the seed/resume is incomplete — never accept it.
		if (completedTurns < expectedTurns) throw new Error("turns_incomplete");
	})();

	try {
		await withTimeout(drain, "worker_turns", 210_000);
	} finally {
		input.close();
		closeQuietly(stream);
	}
	if (!request.expectToken) result.coherent = true;
	return result;
}
