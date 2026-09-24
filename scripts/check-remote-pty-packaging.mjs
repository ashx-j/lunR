import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "1.1.0";
const url = `https://registry.npmjs.org/node-pty/-/node-pty-${version}.tgz`;
const integrity =
	"sha512-20JqtutY6JPXTUnL0ij1uad7Qe1baT46lyolh2sSENDd4sTzKZ4nmAFkeAARDKwmlLjPx6XKRlwRUxwjOy+lUg==";
const targets = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];
const directory = await mkdtemp(join(tmpdir(), "lunr-pty-packaging-"));

try {
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	assert.ok(response.ok, `Download failed: HTTP ${response.status}`);
	const archive = Buffer.from(await response.arrayBuffer());
	assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, integrity);
	const archivePath = "node-pty.tgz";
	await writeFile(join(directory, archivePath), archive);
	const tar = (args) =>
		execFileSync("tar", args, {
			cwd: directory,
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 8 * 1024 * 1024,
		});
	const members = tar(["-tzf", archivePath]).split(/\r?\n/).filter(Boolean);
	const readMember = (name) => tar(["-xOzf", archivePath, `package/${name}`]);
	const manifest = JSON.parse(readMember("package.json"));
	assert.equal(manifest.version, version);
	assert.equal(manifest.scripts.install, "node scripts/prebuild.js || node-gyp rebuild");
	const prebuildScript = readMember("scripts/prebuild.js");
	assert.ok(prebuildScript.includes("`${process.platform}-${process.arch}`"));
	assert.ok(prebuildScript.includes("if (!fs.existsSync(PREBUILD_DIR))"));
	assert.ok(prebuildScript.includes("process.exit(1)"));
	const matrix = targets.map((target) => {
		const files = members.filter((name) => name.startsWith(`package/prebuilds/${target}/`));
		return {
			target,
			files,
			hasNativeAddon: files.some((name) => name.endsWith(".node")),
			installFallsBackToCompiler: files.length === 0,
			runtimeVerified: false,
		};
	});
	const missing = matrix.filter((row) => !row.hasNativeAddon).map((row) => row.target);
	console.log(JSON.stringify({
		experiment: "Published artifact inspection only; no install scripts or native binaries executed",
		version,
		url,
		integrity,
		observer: { platform: process.platform, arch: process.arch, node: process.version },
		installScript: manifest.scripts.install,
		prebuildScript,
		matrix,
		gate: missing.length ? "blocked" : "requires-runtime-validation",
		missing,
	}, null, 2));
	process.exitCode = missing.length ? 1 : 0;
} finally {
	await rm(directory, { recursive: true, force: true });
}
