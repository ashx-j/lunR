import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopLease } from "../src/core/computer-use/lease.ts";
import { macLaunchArguments } from "../src/core/computer-use/macos-runtime.ts";
import { runtimeEnvironment, runtimeInventory } from "../src/core/computer-use/runtime.ts";

const paths: string[] = [];
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "lunr-runtime-test-"));
	paths.push(path);
	return path;
}
afterEach(async () => {
	await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("owned runtime", () => {
	it("removes inherited Cua policy, approval bypass and runtime settings", () => {
		const env = runtimeEnvironment({
			PATH: "test",
			CUA_DRIVER_PERMISSION_MODE: "unrestricted",
			cua_driver_policy_file: "elsewhere",
			CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: "1",
			CUA_DRIVER_RS_UPDATE_CHECK: "true",
		});
		expect(env).toEqual({
			PATH: "test",
			CUA_DRIVER_PERMISSION_MODE: "standard",
			CUA_DRIVER_DISABLE_UNRESTRICTED: "true",
			CUA_DRIVER_RS_UPDATE_CHECK: "false",
			CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
		});
	});
	it("selects an exact signed app and passes daemon-side environment and parent lifetime", () => {
		const args = macLaunchArguments(
			"/private/lunr/CuaDriver.app",
			"/private/session/driver.sock",
			"/private/session",
			"/private/session/lifetime",
		);
		expect(args.slice(0, 5)).toEqual(["-n", "-g", "-W", "-a", "/private/lunr/CuaDriver.app"]);
		expect(args).toEqual(
			expect.arrayContaining([
				"HOME=/private/session",
				"CUA_DRIVER_PERMISSION_MODE=standard",
				"CUA_DRIVER_RS_UPDATE_CHECK=false",
				"CUA_DRIVER_RS_TELEMETRY_ENABLED=false",
				"--parent-liveness-stdio",
				"--socket",
				"/private/session/driver.sock",
			]),
		);
		expect(args).not.toContain("com.trycua.driver");
	});
	it("hashes every cached payload including helpers and DLLs", async () => {
		const path = await directory();
		await writeFile(join(path, "cua-driver.exe"), "driver");
		await writeFile(join(path, "helper.dll"), "original");
		const original = await runtimeInventory(path);
		await writeFile(join(path, "helper.dll"), "modified");
		expect(await runtimeInventory(path)).not.toEqual(original);
	});
	it("refuses a separate live process and recovers only after its death", async () => {
		const path = await directory();
		const module = new URL("../src/core/computer-use/lease.ts", import.meta.url).href;
		const runtime = spawn(process.execPath, ["--eval", "setInterval(()=>{},1000)"], { stdio: "ignore" });
		const script = `import { DesktopLease } from ${JSON.stringify(module)}; const lease = new DesktopLease(${JSON.stringify(path)}); await lease.run(async()=>{}); await lease.trackProcess(${runtime.pid}); console.log('owned'); setInterval(()=>{},1000);`;
		const child = spawn(
			process.execPath,
			["--experimental-transform-types", "--input-type=module", "--eval", script],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let errors = "";
		child.stderr.on("data", (chunk) => {
			errors += chunk;
		});
		try {
			await Promise.race([
				once(child.stdout, "data"),
				once(child, "exit").then(() => {
					throw new Error(errors);
				}),
			]);
			const contender = new DesktopLease(path);
			await expect(contender.run(async () => undefined)).rejects.toThrow("busy");
			const exited = once(child, "exit");
			child.kill();
			await exited;
			await expect(contender.run(async () => undefined)).rejects.toThrow("busy");
			const runtimeExited = once(runtime, "exit");
			runtime.kill();
			await runtimeExited;
			await contender.run(async () => undefined);
			await contender.close();
		} finally {
			child.kill();
			runtime.kill();
		}
	}, 15000);
});
