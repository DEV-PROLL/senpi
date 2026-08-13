export function parseNpmPackJson(output) {
	for (let index = output.indexOf("["); index !== -1; index = output.indexOf("[", index + 1)) {
		try {
			const parsed = JSON.parse(output.slice(index));
			if (Array.isArray(parsed)) {
				return parsed;
			}
		} catch {
			// npm may print warnings before the final JSON payload.
		}
	}
	throw new Error("npm pack --json did not return a JSON array");
}
