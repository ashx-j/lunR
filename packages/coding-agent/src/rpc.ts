#!/usr/bin/env node
import { existsSync } from "node:fs";

const bundled = new URL("./node-runtime/rpc-entry.js", import.meta.url);
if (existsSync(bundled)) {
	await import(bundled.href);
} else {
	await import("./rpc-entry.ts");
}
