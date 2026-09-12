import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOwnedPath, installRuntime, resolveRuntimeArchive } from "../src/core/computer-use/runtime.ts";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("node:os", async (original) => {
	const os = await original<typeof import("node:os")>();
	return {
		...os,
		userInfo: () => {
			if (!state.root) throw new Error("Test home not configured.");
			return { ...os.userInfo(), homedir: state.root };
		},
	};
});
afterEach(async () => {
	vi.unstubAllEnvs();
	if (state.root) await rm(state.root, { recursive: true, force: true });
	state.root = "";
});

describe("verified native installation", () => {
	it("reports unsupported hosts, omitted optional packages, and mismatched package versions without downloads", async () => {
		state.root = await mkdtemp(join(tmpdir(), "lunr-install-test-"));
		await writeFile(join(state.root, "package.json"), JSON.stringify({ version: "0.9.0" }));
		await expect(resolveRuntimeArchive(state.root, "linux", "x64")).rejects.toThrow("unsupported");
		await expect(resolveRuntimeArchive(state.root, "win32", "x64")).rejects.toThrow("optional dependencies enabled");
		const payload = join(state.root, "node_modules", "@ashx-j", "lunr-computer-win32-x64");
		await mkdir(payload, { recursive: true });
		await writeFile(
			join(payload, "package.json"),
			JSON.stringify({ name: "@ashx-j/lunr-computer-win32-x64", version: "0.8.0" }),
		);
		await expect(resolveRuntimeArchive(state.root, "win32", "x64")).rejects.toThrow("version does not match");
	});
	it.skipIf(process.platform !== "win32")(
		"serializes extraction and rejects tampered cached helpers without overwriting them",
		async () => {
			state.root = await mkdtemp(join(tmpdir(), "lunr-install-test-"));
			vi.stubEnv("PI_PACKAGE_DIR", fileURLToPath(new URL("../", import.meta.url)));
			vi.stubEnv("SESSIONNAME", "Console");
			const results = await Promise.allSettled([installRuntime(), installRuntime()]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
				results.map((result) => (result.status === "rejected" ? String(result.reason) : "installed")).join("; "),
			).toHaveLength(1);
			const installed = results.find((result) => result.status === "fulfilled");
			if (installed?.status !== "fulfilled") throw new Error("No installation completed.");
			expect(installed.value.command.startsWith(state.root)).toBe(true);
			expect(await installRuntime()).toEqual(installed.value);
			const helper = join(state.root, ".lunr", "desktop", `runtime-win32-${process.arch}`, "cua-driver-uia.exe");
			await writeFile(helper, "tampered helper");
			await expect(installRuntime()).rejects.toThrow("differs from the verified archive");
			expect(await readFile(helper, "utf8")).toBe("tampered helper");
		},
		60000,
	);
	it("rejects a redirected runtime directory", async () => {
		state.root = await mkdtemp(join(tmpdir(), "lunr-install-test-"));
		const link = join(state.root, "redirect");
		await symlink(state.root, link, process.platform === "win32" ? "junction" : "dir");
		await expect(assertOwnedPath(link)).rejects.toThrow("redirects elsewhere");
	});
});
