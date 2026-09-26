import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareComputerImage, screenshotDimensions } from "../src/core/computer-use/image.ts";

const mocks = vi.hoisted(() => ({ resize: vi.fn(), crop: vi.fn(), load: vi.fn() }));
vi.mock("../src/utils/image-resize.ts", () => ({ resizeImage: mocks.resize }));
vi.mock("../src/utils/photon.ts", () => ({ loadPhoton: mocks.load }));
function png(width: number, height: number) {
	const bytes = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
}
beforeEach(() => {
	mocks.resize.mockReset();
	mocks.crop.mockReset();
	mocks.load.mockReset();
});

describe("computer image preparation", () => {
	it("caps both long edge and area while retaining explicit full-image mapping", async () => {
		mocks.resize.mockImplementation(async (_bytes, _mime, options) => ({
			data: "bounded", fingerprint: "pixels", mimeType: "image/png", width: options.maxWidth, height: options.maxHeight,
			originalWidth: 4096, originalHeight: 2160,
		}));
		const result = await prepareComputerImage(png(4096, 2160));
		expect(result.width).toBeLessThanOrEqual(1280);
		expect(result.width * result.height).toBeLessThanOrEqual(1_000_000);
		expect(result.scaleX).toBe(4096 / result.width);
		expect(result.scaleY).toBe(2160 / result.height);
		expect(mocks.resize.mock.calls[0]?.[2].maxBytes).toBe(1.5 * 1024 * 1024);
		expect(mocks.load).not.toHaveBeenCalled();
	});
	it("crops only the requested region and frees both native image allocations", async () => {
		const original = { get_width: () => 200, get_height: () => 100, get_raw_pixels: () => new Uint8Array(200 * 100 * 4), free: vi.fn() };
		const cropped = { get_bytes: () => Buffer.from("crop"), free: vi.fn() };
		mocks.crop.mockReturnValue(cropped);
		mocks.load.mockResolvedValue({ PhotonImage: { new_from_byteslice: () => original }, crop: mocks.crop });
		mocks.resize.mockResolvedValue({ data: "cropped", mimeType: "image/png", width: 50, height: 30, originalWidth: 50, originalHeight: 30 });
		const result = await prepareComputerImage(png(200, 100), { x: 20, y: 10, width: 50, height: 30 });
		expect(mocks.crop).toHaveBeenCalledWith(original, 20, 10, 70, 40);
		expect(result.region).toEqual({ x: 20, y: 10, width: 50, height: 30 });
		expect(result.scaleX).toBe(1);
		expect(result.image.data).toBe("cropped");
		expect(original.free).toHaveBeenCalledOnce();
		expect(cropped.free).toHaveBeenCalledOnce();
	});
	it("refuses corrupt, oversized or mismatched captures rather than issuing coordinates", async () => {
		expect(() => screenshotDimensions({ type: "image", mimeType: "image/png", data: "invalid" })).toThrow("Invalid screenshot");
		expect(() => screenshotDimensions(png(16000, 16000))).toThrow("budget");
		await expect(prepareComputerImage(png(200, 100), { x: 199, y: 0, width: 2, height: 1 })).rejects.toThrow("outside");
		mocks.resize.mockResolvedValue({ data: "bad", mimeType: "image/png", width: 100, height: 50, originalWidth: 199, originalHeight: 100 });
		await expect(prepareComputerImage(png(200, 100))).rejects.toThrow("could not be decoded");
	});
});
