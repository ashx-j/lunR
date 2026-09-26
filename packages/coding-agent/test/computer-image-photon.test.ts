import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { prepareComputerImage } from "../src/core/computer-use/image.ts";
import { DesktopLease } from "../src/core/computer-use/lease.ts";
import { computerSchemas } from "../src/core/computer-use/schemas.ts";
import { ComputerWorkflow } from "../src/core/computer-use/workflow.ts";
import { loadPhoton } from "../src/utils/photon.ts";

function encodedPng(level: number, red = 80) {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(8, 0);
	header.writeUInt32BE(6, 4);
	header[8] = 8;
	header[9] = 6;
	const rows = Buffer.concat(Array.from({ length: 6 }, () => Buffer.from([0, ...Array.from({ length: 8 }, () => [red, 90, 100, 255]).flat()])));
	return { type: "image" as const, mimeType: "image/png", data: Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows, { level })), chunk("IEND", Buffer.alloc(0)),
	]).toString("base64") };
}

describe("computer image processing with Photon", () => {
	it("identifies decoded pixels across PNG encodings, including the full image behind a crop", async () => {
		const a = encodedPng(0), b = encodedPng(9), changed = encodedPng(9, 81);
		expect(a.data).not.toBe(b.data);
		const first = await prepareComputerImage(a);
		const second = await prepareComputerImage(b);
		const crop = await prepareComputerImage(b, { x: 2, y: 1, width: 4, height: 3 });
		expect(first.fingerprint).toEqual(expect.any(String));
		expect(first.fingerprint).toBe(second.fingerprint);
		expect(crop.fingerprint).toBe(first.fingerprint);
		expect((await prepareComputerImage(changed)).fingerprint).not.toBe(first.fingerprint);
	});
	it("refuses repeating an action when identical pixels use different PNG encodings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "lunr-pixel-repeat-"));
		const call = vi.fn().mockResolvedValueOnce({ content: [encodedPng(0)], structuredContent: { screenshot_width: 8, screenshot_height: 6 } })
			.mockResolvedValueOnce({ content: [], structuredContent: { effect: "unverifiable" } })
			.mockResolvedValueOnce({ content: [encodedPng(9)], structuredContent: { screenshot_width: 8, screenshot_height: 6 } });
		const workflow = new ComputerWorkflow({ call, close: async () => undefined }, new DesktopLease(directory));
		try {
			const target = { pid: 1, window_id: 2 };
			const before = await workflow.execute("computer_observe", target);
			const after = await workflow.execute("computer_click", { ...target, observation: before.details.observation, x: 1, y: 1 });
			expect(JSON.parse(after.content.find((item) => item.type === "text")?.text ?? "{}").unchanged).toBe(true);
			const repeated = await workflow.execute("computer_click", { ...target, observation: after.details.observation, x: 1, y: 1 });
			expect(repeated.details.computer).toMatchObject({ failed: true, workflow: "ready" });
			expect(JSON.parse(repeated.content[0]?.type === "text" ? repeated.content[0].text : "{}").code).toBe("invalid_arguments");
			expect(call).toHaveBeenCalledTimes(3);
		} finally {
			await workflow.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("maps cropped desktop hover to one native pointer move and one full post-image", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const schema = computerSchemas as Record<string, unknown>;
		const prior = Object.getOwnPropertyDescriptor(schema, "computer_hover");
		schema.computer_hover = { properties: { desktop: 1, foreground: 1, observation: 1, x: 1, y: 1 } };
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		const directory = await mkdtemp(join(tmpdir(), "lunr-hover-pixel-"));
		const image = { content: [encodedPng(0)], structuredContent: { screenshot_width: 8, screenshot_height: 6 } };
		const call = vi.fn().mockResolvedValue(image);
		const workflow = new ComputerWorkflow({ call, close: async () => undefined }, new DesktopLease(directory));
		try {
			const full = await workflow.execute("computer_observe", { desktop: true });
			const crop = await workflow.execute("computer_observe", { desktop: true, observation: full.details.observation, crop: { x: 2, y: 1, width: 4, height: 3 } });
			call.mockResolvedValueOnce({ content: [], structuredContent: { effect: "unverifiable" } });
			const pending = workflow.execute("computer_hover", { desktop: true, foreground: true, observation: crop.details.observation, x: 1, y: 1 });
			const result = await pending;
			expect(result.content.filter((item) => item.type === "image")).toHaveLength(1);
			expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}").mapping).toMatchObject({ x: 0, y: 0, width: 8, height: 6 });
			expect(call.mock.calls.map(([name]) => name)).toEqual(["get_desktop_state", "get_desktop_state", "move_cursor", "get_desktop_state"]);
			expect(call.mock.calls[2]?.[1]).toEqual({ scope: "desktop", x: 3, y: 2 });
		} finally {
			await workflow.close();
			await rm(directory, { recursive: true, force: true });
			Object.defineProperty(process, "platform", platform);
			if (prior) Object.defineProperty(schema, "computer_hover", prior);
			else delete schema.computer_hover;
		}
	});
	it("crops real PNG pixels and preserves the coordinate mapping", async () => {
		const photon = await loadPhoton();
		if (!photon) throw new Error("Photon fixture dependency is unavailable");
		const pixels = new Uint8Array(8 * 6 * 4);
		for (let y = 0; y < 6; y++) {
			for (let x = 0; x < 8; x++) pixels.set([x * 20, y * 30, 80, 255], (y * 8 + x) * 4);
		}
		const source = new photon.PhotonImage(pixels, 8, 6);
		try {
			const result = await prepareComputerImage(
				{ type: "image", mimeType: "image/png", data: Buffer.from(source.get_bytes()).toString("base64") },
				{ x: 2, y: 1, width: 4, height: 3 },
			);
			expect(result).toMatchObject({ width: 4, height: 3, sourceWidth: 8, sourceHeight: 6, scaleX: 1, scaleY: 1 });
			expect(result.region).toEqual({ x: 2, y: 1, width: 4, height: 3 });
			const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(result.image.data, "base64"));
			try {
				expect([decoded.get_width(), decoded.get_height()]).toEqual([4, 3]);
				expect(Array.from(decoded.get_raw_pixels().slice(0, 4))).toEqual([40, 30, 80, 255]);
				expect(Array.from(decoded.get_raw_pixels().slice(-4))).toEqual([100, 90, 80, 255]);
			} finally {
				decoded.free();
			}
		} finally {
			source.free();
		}
	});
});
