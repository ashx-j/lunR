#!/usr/bin/env node
/**
 * Fail if any GitHub workflow still publishes @earendil-works/* (upstream pi).
 * lunR may call scripts/publish.mjs — that script rewrites names to @ashx-j/*.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const needle = "@earendil-works" + "/";
const dir = ".github/workflows";
const hits = [];

for (const name of readdirSync(dir)) {
	if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
	const text = readFileSync(join(dir, name), "utf8");
	if (text.includes(needle)) {
		hits.push(name);
	}
}

if (hits.length > 0) {
	console.error(`refusing: ${needle}* referenced from ${hits.join(", ")}`);
	console.error("workflows must not mention the upstream pi npm scope.");
	process.exit(1);
}
