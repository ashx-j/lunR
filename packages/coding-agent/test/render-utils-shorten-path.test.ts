import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { shortenPath } from "../src/core/tools/render-utils.ts";

describe("shortenPath", () => {
	const home = homedir();

	it("replaces the home directory with ~", () => {
		expect(shortenPath(home)).toBe("~");
		expect(shortenPath(`${home}/projects/lunR`)).toBe("~/projects/lunR");
	});

	it("leaves a sibling directory that only shares the prefix alone", () => {
		expect(shortenPath(`${home}2/projects`)).toBe(`${home}2/projects`);
	});
});
