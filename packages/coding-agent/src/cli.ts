#!/usr/bin/env node
import { existsSync } from "node:fs";

const bundled = new URL("./node-runtime/cli-runtime.js", import.meta.url);
if (existsSync(bundled)) {
	await import(bundled.href);
} else {
	await import("./cli-runtime.ts");
}
