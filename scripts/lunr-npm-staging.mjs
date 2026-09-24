import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPublishedTreeHasNoEarendil, rewritePackageJsonForNpm, rewriteWorkspaceSpecifiers } from "./lunr-npm-names.mjs";

const rewriteExtensions = new Set([".js", ".mjs", ".cjs", ".d.ts", ".ts", ".map", ".json"]);

function rewritePublishedTree(root) {
	const stack = [root];
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const name of readdirSync(directory)) {
			const file = join(directory, name);
			if (statSync(file).isDirectory()) {
				if (name !== "node_modules") stack.push(file);
				continue;
			}
			if (![...rewriteExtensions].some((extension) => file.endsWith(extension))) continue;
			const before = readFileSync(file, "utf8");
			const after = rewriteWorkspaceSpecifiers(before);
			if (after !== before) writeFileSync(file, after, "utf8");
		}
	}
}

export function copyPackageForPublish(directory, parent = tmpdir()) {
	const dest = mkdtempSync(join(parent, "lunr-publish-"));
	cpSync(directory, dest, {
		recursive: true,
		filter: (src) => {
			const norm = src.replaceAll("\\", "/");
			if (norm.includes("/node_modules")) return false;
			if (norm.includes("/binaries")) return false;
			if (norm.endsWith("npm-shrinkwrap.json")) return false;
			return true;
		},
	});
	const source = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const rewritten = rewritePackageJsonForNpm(source);
	if (rewritten.repository && rewritten.repository.directory === undefined) delete rewritten.repository.directory;
	writeFileSync(join(dest, "package.json"), `${JSON.stringify(rewritten, null, "\t")}\n`, "utf8");
	rewritePublishedTree(dest);
	assertPublishedTreeHasNoEarendil(dest, rewritten.name);
	return { dest, publishedName: rewritten.name, version: rewritten.version };
}
