import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createSecureContext } from "node:tls";

const directory = await mkdtemp(join(tmpdir(), "lunr-cert-proof-"));
const record = { candidate: "selfsigned@5.5.0", result: "not-run" };
try {
	const userConfig = join(directory, "npmrc");
	await writeFile(userConfig, "registry=https://registry.npmjs.org/\n");
	const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	execFileSync(process.execPath, [npmCli, "install", "--prefix", directory, "--userconfig", userConfig, "--registry=https://registry.npmjs.org/", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--save=false", "selfsigned@5.5.0"], { stdio: "pipe", timeout: 120_000 });
	const { generate } = createRequire(join(directory, "entry.cjs"))("selfsigned");
	const now = new Date();
	const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
	const generated = await generate([{ name: "commonName", value: "localhost" }], {
		algorithm: "sha256", keyType: "ec", curve: "P-256", notBeforeDate: now, notAfterDate: expiry,
		extensions: [
			{ name: "basicConstraints", cA: false },
			{ name: "keyUsage", digitalSignature: true },
			{ name: "extKeyUsage", serverAuth: true },
			{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }, { type: 7, ip: "::1" }] },
		],
	});
	const certificate = new X509Certificate(generated.cert);
	assert.equal(certificate.signatureAlgorithm, "ecdsa-with-SHA256");
	assert.equal(certificate.checkHost("localhost"), "localhost");
	assert.equal(certificate.checkIP("127.0.0.1"), "127.0.0.1");
	assert.equal(certificate.checkIP("::1"), "::1");
	assert.ok(certificate.verify(certificate.publicKey));
	assert.equal(certificate.publicKey.export({ type: "spki", format: "pem" }), createPublicKey(generated.private).export({ type: "spki", format: "pem" }));
	assert.ok(new Date(certificate.validTo).getTime() <= expiry.getTime() + 1000);
	createSecureContext({ key: generated.private, cert: generated.cert });
	record.result = "passed";
	record.observations = ["SHA-256 ECDSA P-256 signature", "DNS and IPv4/IPv6 SANs", "self-signature and private/public key match", "24-hour expiry", "Node TLS context accepts key/cert"];
} catch (error) {
	record.failure = String(error?.stack ?? error);
	process.exitCode = 1;
} finally {
	await rm(directory, { recursive: true, force: true });
	console.log(JSON.stringify(record, null, 2));
}
