import { afterEach, describe, expect, it, vi } from "vitest";
import { getLatestVersion } from "../src/utils/tools-manager.ts";

describe("latest fd and rg version", () => {
	afterEach(() => vi.unstubAllGlobals());

	const stubFetch = (respond: (url: string) => Response) => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			return respond(url);
		});
		return urls;
	};

	// The REST API allows 60 unauthenticated calls per hour per address, so it must not be the first choice.
	it("reads the tag from the release page redirect without calling the API", async () => {
		const urls = stubFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.5.2" },
				}),
		);
		expect(await getLatestVersion("sharkdp/fd")).toBe("10.5.2");
		expect(urls).toEqual(["https://github.com/sharkdp/fd/releases/latest"]);
	});

	it("falls back to the API when the release page gives no tag", async () => {
		const urls = stubFetch((url) =>
			url.startsWith("https://api.github.com/")
				? Response.json({ tag_name: "16.0.0" })
				: new Response("", { status: 200 }),
		);
		expect(await getLatestVersion("BurntSushi/ripgrep")).toBe("16.0.0");
		expect(urls).toHaveLength(2);
	});
});
