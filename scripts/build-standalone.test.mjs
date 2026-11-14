import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { standaloneExternalArgs } from "./build-standalone.mjs";

function textPDF() {
	const stream = "BT /F1 12 Tf 72 720 Td (Standalone PDF text) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("relocated bundle retains Chromium, HTML and PDF text extraction without optional renderers or BiDi", () => {
	const directory = mkdtempSync(join(tmpdir(), "lunr-standalone-build-"));
	const relocated = mkdtempSync(join(tmpdir(), "lunr-standalone-run-"));
	try {
		const modulePath = (name) => JSON.stringify(fileURLToPath(import.meta.resolve(name)));
		const entrypoint = join(directory, "probe.mjs");
		writeFileSync(
			entrypoint,
			`
import assert from "node:assert/strict";
import { chromium } from ${modulePath("playwright-core")};
import { server } from ${modulePath("playwright-core/lib/coreBundle")};
import { parseHTML } from ${modulePath("linkedom")};
import { Readability } from ${modulePath("@mozilla/readability")};
import { getDocumentProxy } from ${modulePath("unpdf")};

assert.equal(chromium.name(), "chromium");
assert.equal(typeof chromium.launch, "function");
assert.throws(() => require.resolve("canvas"), /Cannot find|Cannot resolve|MODULE_NOT_FOUND/);
const paragraph = "Article extraction keeps its real DOM implementation. ".repeat(30);
const { document } = parseHTML("<html><head><title>Bundle article</title></head><body><article><h1>Bundle article</h1><p>" + paragraph + "</p></article><canvas></canvas></body></html>");
const article = new Readability(document).parse();
assert.equal(article.title, "Bundle article");
assert.ok(article.textContent.includes(paragraph));
// LinkeDOM's own optional-renderer fallback has no drawing context.
assert.equal(document.querySelector("canvas").getContext("2d"), null);
const pdf = await getDocumentProxy(new TextEncoder().encode(${JSON.stringify(textPDF())}));
assert.equal(pdf.numPages, 1);
const page = await pdf.getPage(1);
const text = await page.getTextContent();
assert.equal(text.items.map(item => item.str || "").join(" "), "Standalone PDF text");
await pdf.destroy();
// Invoke only the lazy adapter initializer, with inert transport objects. No browser starts.
const playwright = server.createPlaywright({ sdkLanguage: "javascript", isServer: false });
await assert.rejects(playwright.chromium._bidiChromium.connectToTransport({}, {}, {}), /chromium-bidi/);
console.log("standalone capabilities passed");
`,
		);
		const binary = join(directory, process.platform === "win32" ? "probe.exe" : "probe");
		const build = spawnSync(
			"bun",
			["build", "--compile", ...standaloneExternalArgs, entrypoint, "--outfile", binary],
			{
				encoding: "utf8",
				timeout: 60000,
			},
		);
		assert.equal(build.status, 0, build.error?.message ?? build.stderr);
		const movedBinary = join(relocated, process.platform === "win32" ? "probe.exe" : "probe");
		renameSync(binary, movedBinary);
		rmSync(directory, { recursive: true, force: true });
		const run = spawnSync(movedBinary, [], {
			cwd: relocated,
			env: { PATH: process.env.PATH, HOME: relocated, USERPROFILE: relocated },
			encoding: "utf8",
			timeout: 30000,
		});
		assert.equal(run.status, 0, run.error?.message ?? run.stderr);
		assert.match(run.stdout, /standalone capabilities passed/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
		rmSync(relocated, { recursive: true, force: true });
	}
});

test("the production graph excludes canvas and Chromium BiDi while both binary build paths share policy", () => {
	const shrinkwrap = JSON.parse(
		readFileSync(new URL("../packages/coding-agent/npm-shrinkwrap.json", import.meta.url)),
	);
	assert.ok(!Object.keys(shrinkwrap.packages).some((path) => /node_modules\/(canvas|chromium-bidi)$/.test(path)));
	const manifest = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url)));
	assert.match(manifest.scripts["build:binary"], /node \.\.\/\.\.\/scripts\/build-standalone\.mjs/);
	const archiveBuild = readFileSync(new URL("./build-binaries.sh", import.meta.url), "utf8");
	assert.match(archiveBuild, /node \.\.\/\.\.\/scripts\/build-standalone\.mjs --target=bun-\$platform/);
});
