import { afterEach, describe, expect, it, vi } from "vitest";
import { readBoundedBody } from "../src/builtin-extensions/pi-web-access/bounded-body.ts";
import { contentPage } from "../src/builtin-extensions/pi-web-access/content-page.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";

function streamingResponse(size: number, headers: HeadersInit = {}) {
	const cancel = vi.fn();
	let sent = 0;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= size) {
					controller.close();
					return;
				}
				const length = Math.min(64 * 1024, size - sent);
				sent += length;
				controller.enqueue(new Uint8Array(length).fill(65));
			},
			cancel,
		}),
		{ headers },
	);
	return { response, cancel };
}

describe("bounded decoded response bodies", () => {
	it.each([{}, { "content-length": "1" }, { "content-length": "1", "content-encoding": "gzip" }])(
		"cancels oversized decoded streams despite headers %j",
		async (headers) => {
			const { response, cancel } = streamingResponse(6 * 1024 * 1024, headers);
			await expect(readBoundedBody(response, 5 * 1024 * 1024)).rejects.toThrow("Response too large");
			expect(cancel).toHaveBeenCalledOnce();
			expect(response.body?.locked).toBe(false);
		},
	);

	it("accepts the exact cap and preserves bytes", async () => {
		const { response, cancel } = streamingResponse(128 * 1024);
		const bytes = await readBoundedBody(response, 128 * 1024);
		expect(bytes.byteLength).toBe(128 * 1024);
		expect(bytes.every((byte) => byte === 65)).toBe(true);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("cancels a pending read and rejects on abort", async () => {
		const cancel = vi.fn();
		const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
		const controller = new AbortController();
		const pending = readBoundedBody(response, 1024, controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(cancel).toHaveBeenCalledOnce();
		expect(response.body?.locked).toBe(false);
	});
});

describe("stored text pagination", () => {
	it.each(["😀".repeat(50_000), "short line\n".repeat(6000), `${"é".repeat(40_000)}\nlast line\n`])(
		"bounds every page and reconstructs the original text",
		(text) => {
			let offset = 0;
			let reconstructed = "";
			for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
				const page = contentPage(text, offset);
				const output = page.content[0].text;
				expect(Buffer.byteLength(output)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
				expect(output.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
				expect(output).not.toContain("�");
				const details = page.details;
				if (!("nextOffset" in details)) throw new Error("Expected page metadata");
				const body = details.truncated ? output.slice(0, output.lastIndexOf("\n\n[Truncated.")) : output;
				reconstructed += body;
				if (details.nextOffset === null) break;
				expect(details.nextOffset).toBeGreaterThan(offset);
				offset = details.nextOffset;
			}
			expect(reconstructed).toBe(text);
		},
	);

	it("bounds large error metadata without duplicating it", () => {
		const error = "failure ".repeat(20_000);
		const page = contentPage(error, 0, { error });
		expect(JSON.stringify(page.details).length).toBeLessThan(1000);
		expect(page.details).toMatchObject({ truncated: true });
	});

	it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, 1])("rejects unusable offsets %s", (offset) => {
		expect(contentPage("😀text", offset).details).toEqual({
			error: "Invalid offset",
		});
	});
});

const http = vi.hoisted(() => ({
	fetchRemoteUrl: vi.fn(),
	loadPdfExtract: vi.fn(),
}));
vi.mock("../src/builtin-extensions/pi-web-access/ssrf-protection.ts", () => ({
	fetchRemoteUrl: http.fetchRemoteUrl,
	validateRemoteUrl: vi.fn(),
}));
vi.mock("../src/builtin-extensions/pi-web-access/lazy.ts", () => ({
	loadPdfExtract: http.loadPdfExtract,
}));

afterEach(() => vi.clearAllMocks());

describe("HTTP extraction limits before parsing", () => {
	it.each([
		["text/html", 5, {}],
		["text/plain", 5, { "content-length": "1" }],
		["application/pdf", 20, { "content-encoding": "gzip", "content-length": "1" }],
	] as const)("rejects oversized %s before parsing or fallback", async (type, limitMiB, headers) => {
		const { response, cancel } = streamingResponse((limitMiB + 1) * 1024 * 1024, {
			...headers,
			"content-type": type,
		});
		http.fetchRemoteUrl.mockResolvedValue(response);
		const { extractContent } = await import("../src/builtin-extensions/pi-web-access/extract.ts");
		const result = await extractContent("https://example.com/large");
		expect(result).toMatchObject({
			content: "",
			error: expect.stringContaining("Response too large"),
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(http.loadPdfExtract).not.toHaveBeenCalled();
		expect(http.fetchRemoteUrl).toHaveBeenCalledOnce();
	});
});
