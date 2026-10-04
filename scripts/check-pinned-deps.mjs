import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function trackedManifests(root) {
	return execFileSync("git", ["ls-files", "-z", "--", "package.json", ":(glob)**/package.json"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\0")
		.filter(Boolean);
}

function isInternalWorkspaceDependency(name) {
	return name.startsWith("@earendil-works/pi-");
}

function isNonRegistrySpecifier(specifier) {
	return /^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:|git:\/\/)/.test(specifier);
}

function getVersionSpecifier(specifier) {
	if (!specifier.startsWith("npm:")) return specifier;
	const aliasTarget = specifier.slice("npm:".length);
	const versionSeparator = aliasTarget.lastIndexOf("@");
	if (versionSeparator <= 0) return specifier;
	return aliasTarget.slice(versionSeparator + 1);
}

export function checkPinnedDependencies(root, packageJsonFiles = trackedManifests(root)) {
	const failures = [];

	for (const file of packageJsonFiles.sort()) {
		const packageJson = JSON.parse(readFileSync(join(root, file), "utf8"));

		for (const section of dependencySections) {
			const dependencies = packageJson[section];
			if (!dependencies) continue;

			for (const [name, specifier] of Object.entries(dependencies)) {
				if (isInternalWorkspaceDependency(name) || isNonRegistrySpecifier(specifier)) continue;
				if (exactVersionPattern.test(getVersionSpecifier(specifier))) continue;
				failures.push(`${file}: ${section}.${name} must be pinned, found ${specifier}`);
			}
		}
	}

	return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const failures = checkPinnedDependencies(process.cwd());
	if (failures.length > 0) {
		console.error("Direct external dependencies must use exact versions:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
}
