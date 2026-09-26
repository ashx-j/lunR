import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage } from "../../utils/image-resize.ts";
import { loadPhoton } from "../../utils/photon.ts";

export interface ImageRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function screenshotDimensions(image: ImageContent): { width: number; height: number } {
	if (image.mimeType !== "image/png" || image.data.length > 64 * 1024 * 1024)
		throw new Error("Expected a bounded PNG screenshot.");
	const bytes = Buffer.from(image.data, "base64");
	if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
		throw new Error("Invalid screenshot PNG.");
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000)
		throw new Error("Screenshot dimensions exceed the supported capture budget.");
	return { width, height };
}

export async function prepareComputerImage(image: ImageContent, crop?: ImageRegion) {
	const source = screenshotDimensions(image);
	const region = crop ?? { x: 0, y: 0, ...source };
	if (
		![region.x, region.y, region.width, region.height].every(Number.isInteger) ||
		region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
		region.x + region.width > source.width || region.y + region.height > source.height
	) throw new Error("Crop is outside the captured image.");
	let bytes: Uint8Array = Buffer.from(image.data, "base64");
	let fingerprint: string | undefined;
	if (crop) {
		const photon = await loadPhoton();
		if (!photon) throw new Error("Image processing is unavailable; crop refused.");
		const original = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			if (original.get_width() !== source.width || original.get_height() !== source.height)
				throw new Error("Decoded screenshot dimensions changed.");
			fingerprint = createHash("sha256").update(`${source.width}x${source.height}:`).update(original.get_raw_pixels()).digest("hex");
			const cropped = photon.crop(original, region.x, region.y, region.x + region.width, region.y + region.height);
			try {
				bytes = cropped.get_bytes();
			} finally {
				cropped.free();
			}
		} finally {
			original.free();
		}
	}
	const ratio = Math.min(1, 1280 / Math.max(region.width, region.height), Math.sqrt(1_000_000 / (region.width * region.height)));
	const resized = await resizeImage(bytes, "image/png", {
		maxWidth: Math.max(1, Math.floor(region.width * ratio)),
		maxHeight: Math.max(1, Math.floor(region.height * ratio)),
		maxBytes: 1.5 * 1024 * 1024,
		includePixelFingerprint: !crop,
	});
	if (!resized || resized.originalWidth !== region.width || resized.originalHeight !== region.height ||
		resized.width < 1 || resized.height < 1 || resized.width > 1280 || resized.height > 1280 ||
		resized.width * resized.height > 1_000_000)
		throw new Error("Screenshot could not be decoded within the image budget.");
	fingerprint ??= resized.fingerprint;
	if (!fingerprint) throw new Error("Screenshot pixel identity could not be verified.");
	return {
		fingerprint,
		image: { type: "image", data: resized.data, mimeType: resized.mimeType } satisfies ImageContent,
		width: resized.width,
		height: resized.height,
		sourceWidth: source.width,
		sourceHeight: source.height,
		region,
		scaleX: region.width / resized.width,
		scaleY: region.height / resized.height,
	};
}
