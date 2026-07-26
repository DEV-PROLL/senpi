import { createServer } from "node:http";
import { API_PRESETS } from "./mock-loop-support.mjs";

export const POLICY_REFUSAL =
	"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.";
export const FALLBACK_MODEL_ID = "mock-claude-fallback";
export const FINAL_MARKER = "SENPI-QA-ANTHROPIC-POLICY-FALLBACK-8a3d";
export const PRIMARY_CONTINUED_MARKER = "SENPI-QA-PRIMARY-CONTINUED-WRONG-5f92";

const API_NAME = "anthropic-messages";

export function startPolicyRefusalServer() {
	const requests = [];
	let primaryRequests = 0;
	const server = createServer(async (request, response) => {
		const body = await readRequestBody(request);
		const payload = JSON.parse(body);
		requests.push({ method: request.method, path: request.url, model: payload.model });
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		if (payload.model === API_PRESETS[API_NAME].modelId) {
			primaryRequests++;
			if (primaryRequests === 1) writePolicyRefusal(response, payload.model);
			else writeTextResponse(response, payload.model, PRIMARY_CONTINUED_MARKER);
		} else {
			writeTextResponse(response, payload.model, FINAL_MARKER);
		}
		response.end();
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("policy refusal server has no TCP address"));
			const origin = `http://127.0.0.1:${address.port}`;
			resolve({
				origin,
				url: `${origin}/v1`,
				requests,
				get listening() {
					return server.listening;
				},
				stop: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

function writePolicyRefusal(response, model) {
	writeSse(response, "message_start", messageStart(model));
	writeSse(response, "content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "toolu_policy_refusal", name: "bash", input: {} },
	});
	writeSse(response, "content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: '{"command":"printf policy-refusal-probe"}' },
	});
	writeSse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
	writeSse(response, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: "refusal", stop_sequence: null, stop_details: { explanation: POLICY_REFUSAL } },
		usage: { output_tokens: 1 },
	});
	writeSse(response, "message_stop", { type: "message_stop" });
}

function writeTextResponse(response, model, text) {
	writeSse(response, "message_start", messageStart(model));
	writeSse(response, "content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	});
	writeSse(response, "content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text },
	});
	writeSse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
	writeSse(response, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 1 },
	});
	writeSse(response, "message_stop", { type: "message_stop" });
}

function messageStart(model) {
	return {
		type: "message_start",
		message: {
			id: "msg_policy_refusal",
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	};
}

function writeSse(response, event, data) {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readRequestBody(request) {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}
