#!/usr/bin/env node
/**
 * Fail if more files under packages/ carry `// @ts-nocheck` than allowedNocheckFiles.
 * The limit may only go down: when the count drops, lower the constant in the same change.
 * The directive counts when it is the first line, or the line right after a `#!` shebang.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const allowedNocheckFiles = 182;

const ignoredDirectories = new Set([".git", "dist", "extension-repos", "hermes-agent", "kimi-cli", "node_modules", "pi"]);
const sourceExtensions = /\.(?:[cm]?[jt]s|tsx)$/;
const files = [];

function collectNocheckFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) collectNocheckFiles(path);
			continue;
		}
		if (!entry.isFile() || !sourceExtensions.test(entry.name)) continue;

		const lines = readFileSync(path, "utf8").split("\n", 2);
		const directiveLine = lines[0].startsWith("#!") ? lines[1] : lines[0];
		if (directiveLine?.trimEnd() === "// @ts-nocheck") files.push(path);
	}
}

collectNocheckFiles("packages");

if (files.length > allowedNocheckFiles) {
	console.error(`${files.length} files carry // @ts-nocheck; the limit is ${allowedNocheckFiles}.`);
	console.error("fix the type errors instead of adding the directive; the limit may only go down.");
	process.exit(1);
}

if (files.length < allowedNocheckFiles) {
	console.log(`${files.length} files carry // @ts-nocheck: lower the constant to ${files.length} in scripts/check-ts-nocheck-count.mjs.`);
}
