import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadPhoton } from "../src/utils/photon.ts";

const execute = promisify(execFile);
const probe = fileURLToPath(new URL("./fixtures/exif-orientation-probe.ts", import.meta.url));

function chunk(id: string, data = Buffer.alloc(0), size = data.length, padding = true) {
	const header = Buffer.alloc(8);
	header.write(id);
	header.writeUInt32LE(size, 4);
	return Buffer.concat([header, data, padding && size % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function webp(...chunks: Buffer[]) {
	const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
	const header = Buffer.alloc(8);
	header.write("RIFF");
	header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}
function tiff() {
	const bytes = Buffer.alloc(26);
	bytes.write("II");
	bytes.writeUInt16LE(42, 2);
	bytes.writeUInt32LE(8, 4);
	bytes.writeUInt16LE(1, 8);
	bytes.writeUInt16LE(0x112, 10);
	bytes.writeUInt16LE(3, 12);
	bytes.writeUInt32LE(1, 14);
	bytes.writeUInt16LE(2, 18);
	return bytes;
}

async function runProbe(mode: "parser" | "decoder", bytes: Buffer, flips: string[] = []) {
	return execute(process.execPath, [probe, JSON.stringify({ mode, data: bytes.toString("base64"), flips })], {
		timeout: 2000,
		killSignal: "SIGKILL",
		maxBuffer: 16384,
	});
}

describe("bounded WebP EXIF parsing", () => {
	it.each([0x80000000, 0xfffffff8, 0xffffffff])("terminates on unsigned oversized chunk length %i", async (size) => {
		await runProbe("parser", webp(chunk("JUNK", Buffer.alloc(0), size)));
	});
	it.each([
		["truncated header", webp(Buffer.from("JUNK\x00\x00\x00"))],
		["truncated unknown payload", webp(chunk("JUNK", Buffer.alloc(0), 8))],
		["truncated EXIF payload", webp(chunk("EXIF", tiff(), 100))],
		["unsigned oversized EXIF payload", webp(chunk("EXIF", tiff(), 0x80000000))],
		[
			"invalid RIFF extent",
			(() => {
				const bytes = webp(chunk("EXIF", tiff()));
				bytes.writeUInt32LE(0xffffffff, 4);
				return bytes;
			})(),
		],
		[
			"EXIF outside the declared RIFF extent",
			(() => {
				const bytes = webp(chunk("EXIF", tiff()));
				bytes.writeUInt32LE(4, 4);
				return bytes;
			})(),
		],
		["missing odd EXIF padding", webp(chunk("EXIF", Buffer.concat([tiff(), Buffer.alloc(1)]), 27, false))],
		["TIFF extending past its EXIF chunk", webp(chunk("EXIF", tiff(), 8, false))],
	])("ignores %s", async (_name, bytes) => {
		await runProbe("parser", bytes);
	});
	it("advances over empty and padded chunks to valid EXIF", async () => {
		await runProbe("parser", webp(chunk("JUNK"), chunk("JUNK", Buffer.from([1])), chunk("EXIF", tiff())), [
			"horizontal",
		]);
	});
	it("accepts the optional Exif prefix", async () => {
		await runProbe("parser", webp(chunk("EXIF", Buffer.concat([Buffer.from("Exif\x00\x00"), tiff()]))), [
			"horizontal",
		]);
	});
	it("keeps a timed real-decoder check separate from parser fixtures", async () => {
		const photon = await loadPhoton();
		if (!photon) throw new Error("Photon fixture dependency is unavailable");
		const source = new photon.PhotonImage(new Uint8Array([80, 90, 100, 255]), 1, 1);
		try {
			const valid = Buffer.from(source.get_bytes_webp());
			const baseline = await runProbe("decoder", valid);
			expect(JSON.parse(baseline.stdout)).toEqual({ accepted: true });
			const malformed = Buffer.concat([valid, chunk("JUNK", Buffer.alloc(0), 0x80000000)]);
			malformed.writeUInt32LE(malformed.length - 8, 4);
			const result = await runProbe("decoder", malformed);
			// Decoder acceptance alone does not qualify the production resize path or a real caller.
			expect(JSON.parse(result.stdout)).toEqual({ accepted: true });
		} finally {
			source.free();
		}
	});
});
