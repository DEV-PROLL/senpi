import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveSocketTransportAddress } from "../src/modes/rpc/socket-transport.ts";

describe("resolveSocketTransportAddress", () => {
	it("maps a logical Windows socket path to one deterministic named pipe", () => {
		// Given
		const logicalSocket = "C:\\Users\\demo\\.omo\\rpc\\rpc.sock";
		const expectedHash = createHash("sha256").update(logicalSocket, "utf8").digest("hex").slice(0, 32);

		// When
		const address = resolveSocketTransportAddress(logicalSocket, "win32");

		// Then
		expect(address).toBe(`\\\\.\\pipe\\senpi-rpc-${expectedHash}`);
	});

	it("maps the same logical socket to the same pipe for every caller", () => {
		// Given
		const logicalSocket = "C:\\Users\\demo\\.omo\\rpc\\rpc.sock";

		// When
		const listenerAddress = resolveSocketTransportAddress(logicalSocket, "win32");
		const clientAddress = resolveSocketTransportAddress(logicalSocket, "win32");

		// Then
		expect(clientAddress).toBe(listenerAddress);
	});

	it("preserves POSIX filesystem and abstract socket addresses", () => {
		// Given
		const filesystemSocket = "/tmp/senpi/rpc.sock";
		const abstractSocket = "\0senpi-rpc";

		// When
		const resolvedFilesystem = resolveSocketTransportAddress(filesystemSocket, "linux");
		const resolvedAbstract = resolveSocketTransportAddress(abstractSocket, "linux");

		// Then
		expect(resolvedFilesystem).toBe(filesystemSocket);
		expect(resolvedAbstract).toBe(abstractSocket);
	});
});
