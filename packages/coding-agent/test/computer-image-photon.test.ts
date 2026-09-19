import { describe, expect, it } from "vitest";
import { prepareComputerImage } from "../src/core/computer-use/image.ts";
import { loadPhoton } from "../src/utils/photon.ts";

describe("computer image processing with Photon", () => {
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
