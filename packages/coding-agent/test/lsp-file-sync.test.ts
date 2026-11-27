import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileSync } from "../src/builtin-extensions/pi-lsp-extension/src/file-sync.ts";
import type { LspClient } from "../src/builtin-extensions/pi-lsp-extension/src/lsp-client.ts";
import type { LspManager } from "../src/builtin-extensions/pi-lsp-extension/src/lsp-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A client that records the notifications it got. */
function fakeClient(name: string, log: string[]): LspClient {
	const client: Pick<LspClient, "didOpen" | "didChange" | "didClose"> = {
		didOpen: (uri, _languageId, version) => log.push(`${name} open ${basename(fileURLToPath(uri))} v${version}`),
		didChange: (uri, version) => log.push(`${name} change ${basename(fileURLToPath(uri))} v${version}`),
		didClose: (uri) => log.push(`${name} close ${basename(fileURLToPath(uri))}`),
	};
	return client as LspClient;
}

/** A manager whose running TypeScript client the test swaps, as an auto-restart does. */
function fakeManager(dir: string) {
	const state: { client: LspClient | null } = { client: null };
	const manager: Pick<
		LspManager,
		"resolvePath" | "getFileUri" | "getLanguageId" | "getRunningClient" | "getClientForFile"
	> = {
		resolvePath: (path) => join(dir, path),
		getFileUri: (abs) => pathToFileURL(abs).toString(),
		getLanguageId: (abs) => (abs.endsWith(".ts") ? "typescript" : null),
		getRunningClient: () => state.client,
		getClientForFile: async () => state.client,
	};
	return { manager: manager as LspManager, state };
}

describe("FileSync after a language server restart", () => {
	it("opens a tracked file again on the new server instead of sending it a change it cannot apply", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lunr-file-sync-"));
		dirs.push(dir);
		writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
		const log: string[] = [];
		const { manager, state } = fakeManager(dir);
		const sync = new FileSync(manager, 1);
		state.client = fakeClient("old", log);

		await sync.handleFileWrite("a.ts");
		await sync.handleFileWrite("a.ts");
		state.client = fakeClient("new", log);
		await sync.handleFileWrite("a.ts");
		await sync.handleFileRead("a.ts");
		await sync.handleFileWrite("a.ts");
		await sync.handleFileWrite("b.ts");

		expect(log).toEqual([
			"old open a.ts v1",
			"old change a.ts v2",
			"new open a.ts v3",
			"new change a.ts v4",
			"new open b.ts v1",
			"new close a.ts",
		]);
	});

	it("opens the tracked files on a restarted server as soon as it is ready", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lunr-file-sync-"));
		dirs.push(dir);
		writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
		const log: string[] = [];
		const { manager, state } = fakeManager(dir);
		const sync = new FileSync(manager);
		state.client = fakeClient("old", log);

		await sync.handleFileWrite("a.ts");
		await sync.reopen();
		state.client = fakeClient("new", log);
		await sync.reopen();
		await sync.handleFileWrite("a.ts");

		expect(log).toEqual(["old open a.ts v1", "new open a.ts v2", "new change a.ts v3"]);
	});

	it("re-opens a file the old server had when it is read on the new one, and closes nothing on the old one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lunr-file-sync-"));
		dirs.push(dir);
		writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
		const log: string[] = [];
		const { manager, state } = fakeManager(dir);
		const sync = new FileSync(manager, 1);
		state.client = fakeClient("old", log);

		await sync.handleFileRead("a.ts");
		state.client = fakeClient("new", log);
		await sync.handleFileRead("a.ts");
		state.client = fakeClient("newer", log);
		await sync.handleFileRead("b.ts");

		expect(log).toEqual(["old open a.ts v1", "new open a.ts v2", "newer open b.ts v1"]);
	});
});
