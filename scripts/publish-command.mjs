export function buildPublishArgs({ githubActions }) {
	const args = ["publish", "--access", "public", "--tag", "latest"];
	if (githubActions) {
		args.push("--provenance");
	}
	args.push("--ignore-scripts");
	return args;
}
