import { posix } from "node:path";
import semver from "semver";

/**
 * @typedef {object} LockEntry
 * @property {string} [version]
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [optionalDependencies]
 * @property {Record<string, string>} [peerDependencies]
 * @property {Record<string, {optional?: boolean}>} [peerDependenciesMeta]
 */

export function runtimeDependencies(entry) {
	const requiredPeers = Object.fromEntries(
		Object.entries(entry.peerDependencies ?? {}).filter(([name]) => !entry.peerDependenciesMeta?.[name]?.optional),
	);
	return { ...requiredPeers, ...entry.dependencies, ...entry.optionalDependencies };
}

/** Follow ancestor node_modules directories only. A matching name in a sibling workspace is unusable. */
export function resolveDependencyPath(packages, name, from) {
	let directory = from;
	while (true) {
		if (posix.basename(directory) !== "node_modules") {
			const candidate = `${directory ? `${directory}/` : ""}node_modules/${name}`;
			if (packages[candidate] && !packages[candidate].link) return candidate;
		}
		if (!directory) break;
		const parent = posix.dirname(directory);
		directory = parent === "." ? "" : parent;
	}
	throw new Error(`Cannot resolve ${name} from ${from || "root"}`);
}

/** Keep source resolution separate from shipped locations, nesting conflicting hoisted versions. */
export function buildDistributionGraph(sourcePackages, rootEntry, sourceRoot, workspaces) {
	/** @type {Record<string, LockEntry>} */
	const packages = { "": rootEntry };
	const sources = new Map([["", sourceRoot]]);
	const queue = [];
	const enqueue = (entry, sourceFrom, outputFrom, workspaceRoot, outputRoot) => {
		for (const name of Object.keys(runtimeDependencies(entry))) {
			queue.push({ name, sourceFrom, outputFrom, workspaceRoot, outputRoot });
		}
	};
	enqueue(rootEntry, sourceRoot, "", sourceRoot, "");

	for (let index = 0; index < queue.length; index++) {
		const item = queue[index];
		const workspace = workspaces.get(item.name);
		const sourcePath = workspace?.lockPath ?? resolveDependencyPath(sourcePackages, item.name, item.sourceFrom);
		const entry = workspace?.entry ?? sourcePackages[sourcePath];
		let existing;
		try {
			existing = resolveDependencyPath(packages, item.name, item.outputFrom);
		} catch {
			// This dependency has not been placed in a reachable directory yet.
		}
		if (existing && sources.get(existing) === sourcePath) continue;
		const prefix = `${item.workspaceRoot}/node_modules/`;
		let outputPath = workspace
			? `node_modules/${item.name}`
			: sourcePath.startsWith(prefix)
				? `${item.outputRoot ? `${item.outputRoot}/` : ""}node_modules/${sourcePath.slice(prefix.length)}`
				: sourcePath;
		if (packages[outputPath] && sources.get(outputPath) !== sourcePath) {
			outputPath = `${item.outputFrom ? `${item.outputFrom}/` : ""}node_modules/${item.name}`;
		}
		if (packages[outputPath]) {
			if (sources.get(outputPath) !== sourcePath) throw new Error(`Conflicting dependency at ${outputPath}`);
			continue;
		}
		packages[outputPath] = entry;
		sources.set(outputPath, sourcePath);
		enqueue(
			entry,
			sourcePath,
			outputPath,
			workspace ? sourcePath : item.workspaceRoot,
			workspace ? outputPath : item.outputRoot,
		);
	}

	// Validate identity as well as version: a compatible range must not silently change reviewed resolution.
	for (const item of queue) {
		const expected = workspaces.get(item.name)?.lockPath ?? resolveDependencyPath(sourcePackages, item.name, item.sourceFrom);
		const actual = resolveDependencyPath(packages, item.name, item.outputFrom);
		if (sources.get(actual) !== expected) throw new Error(`Changed source resolution for ${item.outputFrom || "root"}/${item.name}`);
	}
	return packages;
}

export function validateDependencyEdges(packages) {
	const errors = [];
	for (const [path, entry] of Object.entries(packages)) {
		for (const [name, spec] of Object.entries({ ...entry.peerDependencies, ...runtimeDependencies(entry) })) {
			try {
				const dependency = packages[resolveDependencyPath(packages, name, path)];
				const range = spec.startsWith("npm:") ? spec.slice(spec.lastIndexOf("@") + 1) : spec;
				if (!semver.validRange(range) || !semver.satisfies(dependency.version, range)) {
					errors.push(`${path || "root"} dependency ${name}@${spec} resolves to ${dependency.version}`);
				}
			} catch (error) {
				if (entry.peerDependenciesMeta?.[name]?.optional && !(name in runtimeDependencies(entry))) continue;
				errors.push(error.message);
			}
		}
	}
	return errors;
}
