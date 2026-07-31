import { createServer } from "node:http";

export async function startFallbackAbortServer() {
	const requests = [];
	const server = createServer(async (request, response) => {
		const body = await readRequestBody(request);
		const payload = JSON.parse(body);
		requests.push({ method: request.method, path: request.url, model: payload.model });
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		if (requests.length > 2) {
			writeTextResponse(response, payload.model, "Fallback abort QA");
			response.end();
			return;
		}
		writeSse(response, "message_start", {
			type: "message_start",
			message: {
				id: `msg_fallback_abort_${requests.length}`,
				type: "message",
				role: "assistant",
				model: payload.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		});
		writeSse(response, "content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: {
				type: "fallback",
				from: { model: payload.model },
				to: { model: `${payload.model}-server-substitute` },
			},
		});
		response.end();
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fallback abort server has no TCP address");
	const origin = `http://127.0.0.1:${address.port}`;
	return {
		origin,
		requests,
		get listening() {
			return server.listening;
		},
		stop: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

function writeSse(response, event, data) {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeTextResponse(response, model, text) {
	writeSse(response, "message_start", {
		type: "message_start",
		message: {
			id: "msg_fallback_abort_title",
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	});
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
