import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Node extension host", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.doUnmock("jiti/static");
		vi.resetModules();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	// jiti/static imports babel eagerly, which cost every launch with a .ts extension about 200 ms.
	it("loads a .ts extension without importing jiti/static", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lunr-jiti-entry-"));
		dirs.push(dir);
		const extensionPath = join(dir, "ext.ts");
		writeFileSync(
			extensionPath,
			"export default (pi: { registerCommand(n: string, o: object): void }) => pi.registerCommand('jiti-entry', { handler: async () => {} });\n",
		);
		const staticEntryLoaded = vi.fn();
		vi.resetModules();
		vi.doMock("jiti/static", () => {
			staticEntryLoaded();
			return {};
		});
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");
		const result = await loadExtensions([extensionPath], dir);
		expect(result.errors).toEqual([]);
		expect([...result.extensions[0].commands.keys()]).toEqual(["jiti-entry"]);
		expect(staticEntryLoaded).not.toHaveBeenCalled();
	});
});
