export function pinSenpiPeerDependency(manifest) {
	if (manifest.peerDependencies?.["@code-yeongyu/senpi"] !== undefined) {
		manifest.peerDependencies["@code-yeongyu/senpi"] = manifest.version;
	}
	return manifest;
}

export function rewritePublishManifest(manifest, { directory, name }) {
	manifest.name = name;
	delete manifest.private;
	pinSenpiPeerDependency(manifest);
	manifest.repository = {
		type: "git",
		url: "git+https://github.com/code-yeongyu/senpi.git",
		directory,
	};
	return manifest;
}
