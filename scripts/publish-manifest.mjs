export function rewritePublishManifest(manifest, { directory, name }) {
	manifest.name = name;
	delete manifest.private;
	manifest.repository = {
		type: "git",
		url: "git+https://github.com/code-yeongyu/senpi.git",
		directory,
	};
	return manifest;
}
