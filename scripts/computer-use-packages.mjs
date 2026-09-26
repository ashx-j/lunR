import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyComputerUseArchive } from "./check-computer-use-release.mjs";

export const release = JSON.parse(await readFile(new URL("./computer-use-release.json", import.meta.url), "utf8"));
export const archiveDirectory = fileURLToPath(new URL("../packages/coding-agent/native/computer-use/", import.meta.url));

function assertVersion(version) {
	if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Invalid native package release version");
}

export function payloadManifest(artifact, version) {
	assertVersion(version);
	return {
		name: artifact.packageName,
		version,
		description: `Pinned CuaDriver ${release.version} payload for lunR on ${artifact.platform}/${artifact.arch}`,
		license: "MIT",
		os: [artifact.platform],
		cpu: [artifact.arch],
		files: [artifact.name, "LICENSE.md"],
		repository: { type: "git", url: "https://github.com/ashx-j/lunR.git" },
	};
}

export async function stagePayloadPackages(destination, version, source = archiveDirectory) {
	const packages = [];
	for (const artifact of release.artifacts) {
		await verifyComputerUseArchive(source, artifact);
		const directory = join(destination, `${artifact.platform}-${artifact.arch}`);
		await mkdir(directory, { recursive: true });
		const manifest = payloadManifest(artifact, version);
		await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
		await copyFile(join(source, artifact.name), join(directory, artifact.name));
		await copyFile(join(archiveDirectory, "LICENSE.md"), join(directory, "LICENSE.md"));
		packages.push({ directory, manifest, artifact });
	}
	return packages;
}

export function addPayloadDependencies(manifest, lock, owner = "") {
	const version = manifest.version;
	assertVersion(version);
	const entry = lock?.packages?.[owner];
	if (lock && !entry) throw new Error(`Missing native dependency owner in lock: ${owner}`);
	manifest.optionalDependencies = { ...manifest.optionalDependencies };
	for (const artifact of release.artifacts) {
		const name = artifact.packageName;
		manifest.optionalDependencies[name] = version;
		if (lock) {
			const shortName = name.split("/")[1];
			lock.packages[`node_modules/${name}`] = {
				version,
				resolved: `https://registry.npmjs.org/${name}/-/${shortName}-${version}.tgz`,
				license: "MIT",
				optional: true,
				os: [artifact.platform],
				cpu: [artifact.arch],
			};
		}
	}
	if (entry) entry.optionalDependencies = { ...manifest.optionalDependencies };
}

export async function copyStandalonePayload(destination, platform, arch, source = archiveDirectory) {
	const artifact = release.artifacts.find((item) => item.platform === platform && item.arch === arch);
	if (!artifact) return false;
	await verifyComputerUseArchive(source, artifact);
	const directory = join(destination, "native", "computer-use");
	await mkdir(directory, { recursive: true });
	await copyFile(join(source, artifact.name), join(directory, artifact.name));
	await copyFile(join(archiveDirectory, "LICENSE.md"), join(directory, "LICENSE.md"));
	await writeFile(join(directory, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
	return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [action, destination, platform = process.platform, arch = process.arch] = process.argv.slice(2);
	if (action !== "standalone" || !destination) {
		throw new Error("Usage: node scripts/computer-use-packages.mjs standalone <destination> [platform] [arch]");
	}
	console.log(await copyStandalonePayload(resolve(destination), platform.replace("windows", "win32"), arch)
		? `Copied verified ${platform}/${arch} computer-use payload.`
		: `No computer-use payload for ${platform}/${arch}.`);
}
