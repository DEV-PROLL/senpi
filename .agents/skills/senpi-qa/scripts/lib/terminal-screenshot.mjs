import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import xtermHeadless from "@xterm/headless";
import { withTimeout } from "./with-timeout.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { Terminal } = xtermHeadless;

export async function renderTerminalScreenshot(root, evidence, raw) {
	if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
	const htmlPath = join(evidence, "terminal.html");
	const pngPath = join(evidence, "terminal.png");
	const profileDir = mkdtempSync(join(tmpdir(), "senpi-qa-chrome-"));
	const terminal = new Terminal({ cols: 120, rows: 36, convertEol: true, allowProposedApi: true });
	await new Promise((resolve) => terminal.write(raw, resolve));
	const viewport = terminal.buffer.active;
	const lines = Array.from({ length: terminal.rows }, (_, row) =>
		viewport.getLine(viewport.viewportY + row)?.translateToString(true) ?? "",
	);
	terminal.dispose();
	const text = escapeHtml(lines.join("\n"));
	writeFileSync(
		htmlPath,
		`<!doctype html><html><head><meta charset="utf-8"><style>` +
			`html,body{margin:0;width:100%;height:100%;background:#0b0d10;color:#e6edf3}` +
			`pre{box-sizing:border-box;margin:0;padding:16px;font:16px/1.2 Menlo,Monaco,monospace;white-space:pre}` +
			`</style></head><body data-ready="true"><pre>${text}</pre></body></html>`,
	);
	const chrome = spawn(
		CHROME,
		[
			"--headless=new",
			"--disable-background-networking",
			"--disable-extensions",
			"--disable-gpu",
			"--hide-scrollbars",
			"--no-default-browser-check",
			"--no-first-run",
			"--allow-file-access-from-files",
			`--user-data-dir=${profileDir}`,
			"--remote-debugging-port=0",
			"--window-size=1400,900",
			pathToFileURL(htmlPath).href,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	try {
		const port = await devToolsPort(chrome);
		const targets = await withTimeout(
			fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()),
			"Chrome target list",
			10_000,
		);
		const page = targets.find((target) => target.type === "page");
		if (!page?.webSocketDebuggerUrl) throw new Error("Chrome did not expose a page target");
		const cdp = await connectCdp(page.webSocketDebuggerUrl);
		try {
			await cdp.send("Runtime.enable");
			await cdp.send("Page.enable");
			const ready = await cdp.send("Runtime.evaluate", {
				expression: `document.body?.dataset.ready === "true"`,
				returnByValue: true,
			});
			if (ready.result?.value !== true) throw new Error("Chrome did not load terminal.html");
			const screenshot = await cdp.send("Page.captureScreenshot", {
				format: "png",
				fromSurface: true,
				captureBeyondViewport: false,
			});
			writeFileSync(pngPath, Buffer.from(screenshot.data, "base64"));
		} finally {
			cdp.close();
		}
	} finally {
		await stopProcess(chrome);
		rmSync(profileDir, { recursive: true, force: true });
	}
	if (!existsSync(pngPath) || statSync(pngPath).size === 0) {
		throw new Error("Chrome did not produce terminal.png");
	}
}

function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function devToolsPort(chrome) {
	return withTimeout(
		new Promise((resolve, reject) => {
			let stderr = "";
			chrome.once("error", reject);
			chrome.stderr.setEncoding("utf8");
			chrome.stderr.on("data", (chunk) => {
				stderr += chunk;
				const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
				if (match) resolve(Number(match[1]));
			});
			chrome.once("exit", (code) => reject(new Error(`Chrome exited before DevTools startup (${code})`)));
		}),
		"Chrome DevTools startup",
		15_000,
	);
}

async function connectCdp(url) {
	const socket = new WebSocket(url);
	await withTimeout(
		new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		}),
		"Chrome DevTools socket",
		10_000,
	);
	let sequence = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (!message.id) return;
		const waiter = pending.get(message.id);
		if (!waiter) return;
		pending.delete(message.id);
		if (message.error) waiter.reject(new Error(message.error.message));
		else waiter.resolve(message.result);
	});
	return {
		send(method, params = {}) {
			return withTimeout(
				new Promise((resolve, reject) => {
					const id = ++sequence;
					pending.set(id, { resolve, reject });
					socket.send(JSON.stringify({ id, method, params }));
				}),
				`Chrome command ${method}`,
				15_000,
			);
		},
		close() {
			socket.close();
		},
	};
}

async function stopProcess(child) {
	if (child.exitCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	try {
		await withTimeout(exited, "Chrome shutdown", 5_000);
	} catch {
		child.kill("SIGKILL");
		await withTimeout(exited, "Chrome forced shutdown", 5_000);
	}
}

