import { spawn } from "node:child_process";
import { defaultExecutableDeps, resolveClaudeCodeExecutable } from "./executable.ts";

export async function readAmbientClaudeAuthStatus(): Promise<boolean> {
	let executable: string;
	try {
		executable = resolveClaudeCodeExecutable(defaultExecutableDeps());
	} catch {
		return false;
	}

	return new Promise((resolve) => {
		let settled = false;
		const finish = (available: boolean) => {
			if (settled) return;
			settled = true;
			resolve(available);
		};
		const child = spawn(executable, ["auth", "status"], { stdio: "ignore" });
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
	});
}
