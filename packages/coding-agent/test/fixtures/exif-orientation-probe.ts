import assert from "node:assert/strict";
import { applyExifOrientation } from "../../src/utils/exif-orientation.ts";
import { loadPhoton } from "../../src/utils/photon.ts";

const input = JSON.parse(process.argv[2]) as { mode: "parser" | "decoder"; data: string; flips?: string[] };
const bytes = Buffer.from(input.data, "base64");
if (input.mode === "decoder") {
	const photon = await loadPhoton();
	assert.ok(photon, "Photon fixture dependency is unavailable");
	let accepted = false;
	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		image.free();
		accepted = true;
	} catch {}
	process.stdout.write(JSON.stringify({ accepted }));
} else {
	const flips: string[] = [];
	const photon = { fliph: () => flips.push("horizontal"), flipv: () => flips.push("vertical") };
	const image = {};
	assert.equal(
		applyExifOrientation(
			photon as unknown as Parameters<typeof applyExifOrientation>[0],
			image as Parameters<typeof applyExifOrientation>[1],
			bytes,
		),
		image,
	);
	assert.deepEqual(flips, input.flips ?? []);
}
