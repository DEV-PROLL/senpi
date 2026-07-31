import { execFileSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function renderTerminalScreenshot(root, evidence, raw) {
	if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
	const xtermRoot = join(root, ".agents", "skills", "senpi-qa", "node_modules", "@xterm", "xterm");
	const js = pathToFileURL(join(xtermRoot, "lib", "xterm.js")).href;
	const css = pathToFileURL(join(xtermRoot, "css", "xterm.css")).href;
	const htmlPath = join(evidence, "terminal.html");
	const pngPath = join(evidence, "terminal.png");
	const encoded = Buffer.from(raw, "utf8").toString("base64");
	writeFileSync(
		htmlPath,
		`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${css}">` +
			`<style>html,body,#terminal{margin:0;width:100%;height:100%;background:#0b0d10}</style>` +
			`<div id="terminal"></div><script src="${js}"></script><script>` +
			`const t=new Terminal({cols:120,rows:36,convertEol:true,fontSize:16,theme:{background:"#0b0d10"}});` +
			`t.open(document.getElementById("terminal"));` +
			`t.write(new TextDecoder().decode(Uint8Array.from(atob("${encoded}"),c=>c.charCodeAt(0))));` +
			`</script>`,
	);
	execFileSync(
		CHROME,
		[
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--allow-file-access-from-files",
			"--virtual-time-budget=3000",
			"--window-size=1400,900",
			`--screenshot=${pngPath}`,
			pathToFileURL(htmlPath).href,
		],
		{ stdio: "pipe", timeout: 30_000 },
	);
	if (!existsSync(pngPath) || statSync(pngPath).size === 0) {
		throw new Error("Chrome did not produce terminal.png");
	}
}
