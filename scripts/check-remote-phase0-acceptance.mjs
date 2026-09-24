#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
	const match = /^--([a-z-]+)=(.+)$/.exec(argument);
	if (!match) throw new Error(`Unknown argument: ${argument}`);
	return [match[1], match[2]];
}));
for (const key of Object.keys(options)) {
	if (!["scope", "target", "node-major", "bun-path"].includes(key)) throw new Error(`Unknown option: --${key}`);
}
const scope = options.scope ?? "full";
assert.ok(["full", "candidate-npm", "product-npm", "standalone"].includes(scope), "Expected --scope=full|candidate-npm|product-npm|standalone");
const target = `${process.platform}-${process.arch}`;
assert.ok(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"].includes(target), `Unsupported native host ${target}`);
if (options.target) assert.equal(target, options.target, "Runner architecture differs from requested target");
const [major, minor] = process.versions.node.split(".").map(Number);
assert.ok(major > 22 || (major === 22 && minor >= 19), `Node version ${process.version} is below the >=22.19 package minimum`);
if (options["node-major"]) assert.equal(major, Number(options["node-major"]), "Node major differs from requested version");

const report = {
	result: "blocked",
	scope,
	host: { target, node: process.version, bun: process.versions.bun ?? null },
	candidate: { nativeRuntime: "not-run", cleanInstall: "not-run", tui: "not-run", detachedInteractions: "not-run", sameSizeReattachAndImage: "not-run" },
	productNpmLayout: "not-run",
	standaloneLayout: "not-run",
};
const probes = [
	["check-remote-pty-alternative.mjs", "nativeRuntime", "runtime"],
	["check-remote-pty-tui.mjs", "tui", "runtime"],
	["check-remote-pty-interactions.mjs", "detachedInteractions", "probe"],
	["check-remote-pty-attach-bridge.mjs", "sameSizeReattachAndImage", "probe"],
];
try {
	for (const [script, field, resultField] of scope === "candidate-npm" || scope === "full" ? probes : []) {
		const execution = spawnSync(process.execPath, [join(root, "scripts", script)], { cwd: root, encoding: "utf8", timeout: 150_000, maxBuffer: 5 * 1024 * 1024 });
		if (execution.error) throw new Error(`${script}: ${execution.error.message}`);
		if (execution.status !== 0) throw new Error(`${script}: exit ${execution.status}\n${execution.stdout}\n${execution.stderr}`);
		const output = JSON.parse(execution.stdout.trim());
		assert.equal(output.cleanInstall?.scriptsEnabled, true);
		assert.equal(output.cleanInstall.lifecycleHooksAbsent, true);
		report.candidate.cleanInstall = "passed: fresh npm install with lifecycle scripts enabled, native package present, no candidate install hooks";
		if (script === "check-remote-pty-alternative.mjs") {
			assert.equal(output.runtime?.result, "passed");
			assert.equal(output.runtime.platform, target);
			assert.equal(output.matrix?.length, 6);
		}
		if (script === "check-remote-pty-tui.mjs") assert.equal(output.runtime?.result, "passed");
		if (script === "check-remote-pty-interactions.mjs") {
			assert.equal(output.result, "passed");
			assert.equal(output.probe?.longToolCompletedWhileDetached, true);
			assert.equal(output.probe?.workerPidUnchanged, true);
		}
		if (script === "check-remote-pty-attach-bridge.mjs") {
			assert.equal(output.result, "passed");
			assert.equal(output.imageReceived, true);
			assert.equal(output.probe?.sameSizeRepaint, true);
			assert.equal(output.probe?.syntheticPngChip, true);
		}
		report.candidate[field] = output[resultField];
	}
	if (["full", "product-npm", "standalone"].includes(scope)) {
		const productScope = scope === "product-npm" ? "npm" : scope;
		const args = [join(root, "scripts", "check-remote-pty-product-artifacts.mjs"), `--scope=${productScope}`];
		if (options["bun-path"]) args.push(`--bun-path=${options["bun-path"]}`);
		const execution = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 600_000, maxBuffer: 5 * 1024 * 1024 });
		if (execution.error) throw execution.error;
		const product = JSON.parse(execution.stdout.trim());
		report.productNpmLayout = product.npm;
		report.standaloneLayout = product.standalone;
		if (execution.status !== 0 && execution.status !== 2) throw new Error(`Product packaging failed: ${product.failure ?? execution.stderr}`);
		if (execution.status === 2) process.exitCode = 2;
	}
	report.result = process.exitCode === 2 ? "blocked: product layout validation incomplete" : scope === "candidate-npm" ? "candidate-npm-passed; product release gate pending" : "passed: requested staged artifact layouts validated";
} catch (error) {
	report.result = "failed";
	report.error = String(error);
	process.exitCode = 1;
}
console.log(JSON.stringify(report));
