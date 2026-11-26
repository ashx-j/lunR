import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendJsonl,
	cleanupOldArtifacts,
	ensureArtifactsDir,
	getArtifactsDir,
	writeArtifact,
	writeMetadata,
} from "../src/builtin-extensions/pi-subagents/src/shared/artifacts.ts";

const mode = (path: string) => lstatSync(path).mode & 0o777;

// Transcripts hold the user's code and prompts, so the tree must stay private whatever the umask.
describe("subagent artifacts dir", () => {
	let root: string;
	let previousUmask: number;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-artifacts-"));
		previousUmask = process.umask(0o000);
	});

	afterEach(() => {
		process.umask(previousUmask);
		rmSync(root, { recursive: true, force: true });
	});

	it("creates 0700 dirs and 0600 files under a loose umask", () => {
		const dir = getArtifactsDir(join(root, "sessions", "s.jsonl"));
		ensureArtifactsDir(dir);
		writeArtifact(join(dir, "a_input.md"), "task");
		writeMetadata(join(dir, "a_meta.json"), { ok: true });
		appendJsonl(join(dir, "a.jsonl"), "{}");
		expect(mode(dir)).toBe(0o700);
		for (const name of readdirSync(dir)) expect(mode(join(dir, name)), name).toBe(0o600);
	});

	it("tightens a tree an older lunR left loose", () => {
		const dir = join(root, "loose", "subagent-artifacts");
		mkdirSync(join(dir, "outputs", "run"), { recursive: true, mode: 0o775 });
		writeFileSync(join(dir, "outputs", "run", "r.md"), "x", { mode: 0o664 });
		ensureArtifactsDir(dir);
		expect([mode(dir), mode(join(dir, "outputs")), mode(join(dir, "outputs", "run"))]).toEqual([0o700, 0o700, 0o700]);
		expect(mode(join(dir, "outputs", "run", "r.md"))).toBe(0o600);
	});

	it("refuses a symlink and never cleans through one", () => {
		const target = join(root, "elsewhere");
		mkdirSync(target);
		const old = join(target, "keep.txt");
		writeFileSync(old, "x");
		utimesSync(old, new Date(0), new Date(0));
		const dir = join(root, "link", "subagent-artifacts");
		mkdirSync(join(root, "link"));
		symlinkSync(target, dir);
		expect(() => ensureArtifactsDir(dir)).toThrow("is not a directory");
		cleanupOldArtifacts(dir, 1);
		expect(readdirSync(target)).toEqual(["keep.txt"]);
	});
});
