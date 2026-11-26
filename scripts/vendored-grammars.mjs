#!/usr/bin/env node
// Checks or refreshes the vendored tree-sitter grammars against vendored-grammars/manifest.json.
//   node scripts/vendored-grammars.mjs check
//     Fails when a vendored file's SHA-256 differs from the manifest, or a file and an entry do not pair up.
//   node scripts/vendored-grammars.mjs update <file.wasm> <package>@<version>
//     Takes <file.wasm> unchanged from that npm package (npm checks the registry integrity) and records it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../packages/coding-agent/src/builtin-extensions/pi-lsp-extension/src/tree-sitter/vendored-grammars",
);
const manifestPath = join(directory, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const [command, file, spec] = process.argv.slice(2);

if (command === "check") {
	const problems = [];
	const files = readdirSync(directory).filter((name) => name.endsWith(".wasm"));
	for (const name of files) {
		if (!manifest[name]) problems.push(`${name} has no manifest entry`);
		else if (sha256(join(directory, name)) !== manifest[name].sha256)
			problems.push(`${name} does not match ${manifest[name].package}@${manifest[name].version}`);
	}
	for (const name of Object.keys(manifest)) if (!files.includes(name)) problems.push(`${name} is listed but missing`);
	if (problems.length > 0) {
		console.error(`Vendored tree-sitter grammars:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
		console.error("Refresh one with: node scripts/vendored-grammars.mjs update <file.wasm> <package>@<version>");
		process.exit(1);
	}
	console.log(`${files.length} vendored tree-sitter grammars match their manifest.`);
} else if (command === "update" && file?.endsWith(".wasm") && spec?.lastIndexOf("@") > 0) {
	const at = spec.lastIndexOf("@");
	const temporary = mkdtempSync(join(tmpdir(), "lunr-grammar-"));
	try {
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const tarball = execFileSync(npm, ["pack", spec, "--silent"], { cwd: temporary, encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").at(-1);
		execFileSync("tar", ["-xzf", tarball, `package/${file}`], { cwd: temporary });
		copyFileSync(join(temporary, "package", file), join(directory, file));
		manifest[file] = { package: spec.slice(0, at), version: spec.slice(at + 1), sha256: sha256(join(directory, file)) };
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		console.log(`${file} from ${spec}: ${manifest[file].sha256}. Update the README table and licenses to match.`);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
} else {
	console.error("Usage: node scripts/vendored-grammars.mjs check | update <file.wasm> <package>@<version>");
	process.exit(2);
}
