import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Publish-time npm identity. Workspace package.json names stay
 * @earendil-works/pi-*. Tarballs we upload must use these names.
 */
export const NPM_SCOPE = "@ashx-j";
export const NPM_CLI_PACKAGE = "@ashx-j/lunr";
export const NPM_DEV_CLI_PACKAGE = "@ashx-j/lunr-dev";

export const WORKSPACE_TO_NPM = {
	"@earendil-works/pi-ai": "@ashx-j/lunr-ai",
	"@earendil-works/pi-tui": "@ashx-j/lunr-tui",
	"@earendil-works/pi-agent-core": "@ashx-j/lunr-agent",
	"@earendil-works/pi-coding-agent": "@ashx-j/lunr",
};

export const DEV_WORKSPACE_TO_NPM = {
	...WORKSPACE_TO_NPM,
	"@earendil-works/pi-coding-agent": NPM_DEV_CLI_PACKAGE,
};

export function publishTagFor(workspaceName, channel) {
	if (channel === "stable") return "latest";
	if (channel !== "dev") throw new Error(`Unknown publish channel: ${channel}`);
	return workspaceName === "@earendil-works/pi-coding-agent" ? "latest" : "dev";
}

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];

export function npmNameFor(workspaceName) {
	return WORKSPACE_TO_NPM[workspaceName];
}

/** Rewrite import/require specifiers in compiled JS (and similar text). */
export function rewriteWorkspaceSpecifiers(text, packageNames = WORKSPACE_TO_NPM) {
	let out = text;
	for (const [from, to] of Object.entries(packageNames).sort((a, b) => b[0].length - a[0].length)) {
		out = out.split(from).join(to);
	}
	return out;
}

export function rewritePackageLockForNpm(lock, options = {}) {
	const packageNames = options.packageNames ?? WORKSPACE_TO_NPM;
	const rewritten = JSON.parse(rewriteWorkspaceSpecifiers(JSON.stringify(lock), packageNames));
	const publicNames = new Set(Object.values(packageNames));
	if (options.version) rewritten.version = options.version;
	for (const [path, entry] of Object.entries(rewritten.packages ?? {})) {
		const name = path === "" ? entry.name : path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
		if (options.version) {
			if (path === "" || publicNames.has(name)) entry.version = options.version;
			for (const field of DEP_FIELDS) {
				for (const dependency of Object.keys(entry[field] ?? {})) {
					if (publicNames.has(dependency)) entry[field][dependency] = options.version;
				}
			}
		}
		if (name === NPM_DEV_CLI_PACKAGE) entry.bin = { "lunr-dev": "dist/dev-cli.js" };
		if (path === "" || !publicNames.has(name)) continue;
		entry.resolved = `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${entry.version}.tgz`;
		delete entry.integrity;
	}
	return rewritten;
}

export function assertNoEarendil(value, label = "package") {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text.includes("@earendil-works/")) {
		throw new Error(`${label} still references @earendil-works/* — refusing to publish`);
	}
}

const PUBLISHED_TEXT_EXTENSIONS = [".js", ".mjs", ".cjs", ".d.ts", ".ts", ".map", ".json"];

export function assertPublishedEntryPointsExist(root, pkg, label = "package") {
	const targets = new Set();
	const visit = (value) => {
		if (typeof value === "string") {
			if (/^\.?\/?dist\//.test(value)) targets.add(value.replace(/^\.\//, ""));
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value && typeof value === "object") {
			for (const item of Object.values(value)) visit(item);
		}
	};
	visit({ main: pkg.main, types: pkg.types, bin: pkg.bin, exports: pkg.exports });
	for (const target of targets) {
		const exists = target.includes("*") ? globSync(target, { cwd: root }).length > 0 : existsSync(join(root, target));
		if (!exists) {
			throw new Error(`${label} ${target} does not exist — refusing to publish`);
		}
	}
}

export function assertPublishedTreeHasNoEarendil(root, label = "package") {
	const stack = [join(root, "dist")];
	let scannedJavaScript = 0;
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const name of readdirSync(directory)) {
			const fullPath = join(directory, name);
			if (statSync(fullPath).isDirectory()) {
				if (name !== "node_modules") stack.push(fullPath);
				continue;
			}
			if (!PUBLISHED_TEXT_EXTENSIONS.some((extension) => fullPath.endsWith(extension))) continue;
			const relativePath = relative(root, fullPath).replaceAll("\\", "/");
			if (/^dist\/.*\.(?:js|mjs|cjs)$/.test(relativePath)) scannedJavaScript++;
			assertNoEarendil(readFileSync(fullPath, "utf8"), `${label} ${relativePath}`);
		}
	}
	if (scannedJavaScript === 0) {
		throw new Error(`${label} has no compiled JavaScript under dist — refusing to publish`);
	}
}

/** Rewrite a package.json object for the public registry. Does not mutate the input. */
export function rewritePackageJsonForNpm(pkg, options = {}) {
	const packageNames = options.packageNames ?? WORKSPACE_TO_NPM;
	const out = structuredClone(pkg);
	const mapped = packageNames[out.name];
	if (!mapped) {
		throw new Error(`no lunR npm name for workspace package ${out.name}`);
	}
	out.name = mapped;
	if (options.version) out.version = options.version;
	if (mapped === NPM_DEV_CLI_PACKAGE) {
		out.bin = { "lunr-dev": "dist/dev-cli.js" };
		out.piConfig = { ...out.piConfig, name: "lunr-dev" };
	}

	for (const field of DEP_FIELDS) {
		const deps = out[field];
		if (!deps || typeof deps !== "object") continue;
		const next = {};
		for (const [dep, ver] of Object.entries(deps)) {
			next[packageNames[dep] ?? dep] = packageNames[dep] && options.version ? options.version : ver;
		}
		out[field] = next;
	}

	if (out.scripts) {
		const scripts = { ...out.scripts };
		delete scripts.prepublishOnly;
		out.scripts = scripts;
	}
	out.repository = {
		type: "git",
		url: "git+https://github.com/ashx-j/lunR.git",
		directory: undefined,
	};
	if (pkg.repository && typeof pkg.repository === "object" && pkg.repository.directory) {
		out.repository.directory = pkg.repository.directory;
	}

	assertNoEarendil(out, mapped);
	return out;
}
