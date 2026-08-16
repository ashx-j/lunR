/**
 * Publish-time npm identity. Workspace package.json names stay
 * @earendil-works/pi-*. Tarballs we upload must use these names.
 */
export const NPM_SCOPE = "@ashx-j";
export const NPM_CLI_PACKAGE = "@ashx-j/lunr";

export const WORKSPACE_TO_NPM = {
	"@earendil-works/pi-ai": "@ashx-j/lunr-ai",
	"@earendil-works/pi-tui": "@ashx-j/lunr-tui",
	"@earendil-works/pi-agent-core": "@ashx-j/lunr-agent",
	"@earendil-works/pi-coding-agent": "@ashx-j/lunr",
};

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];

export function npmNameFor(workspaceName) {
	return WORKSPACE_TO_NPM[workspaceName];
}

const REPLACEMENTS = Object.entries(WORKSPACE_TO_NPM).sort((a, b) => b[0].length - a[0].length);

/** Rewrite import/require specifiers in compiled JS (and similar text). */
export function rewriteWorkspaceSpecifiers(text) {
	let out = text;
	for (const [from, to] of REPLACEMENTS) {
		out = out.split(from).join(to);
	}
	return out;
}

export function assertNoEarendil(value, label = "package") {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (text.includes("@earendil-works/")) {
		throw new Error(`${label} still references @earendil-works/* — refusing to publish`);
	}
}

/** Rewrite a package.json object for the public registry. Does not mutate the input. */
export function rewritePackageJsonForNpm(pkg) {
	const out = structuredClone(pkg);
	const mapped = WORKSPACE_TO_NPM[out.name];
	if (!mapped) {
		throw new Error(`no lunR npm name for workspace package ${out.name}`);
	}
	out.name = mapped;

	for (const field of DEP_FIELDS) {
		const deps = out[field];
		if (!deps || typeof deps !== "object") continue;
		const next = {};
		for (const [dep, ver] of Object.entries(deps)) {
			next[WORKSPACE_TO_NPM[dep] ?? dep] = ver;
		}
		out[field] = next;
	}

	if (Array.isArray(out.files)) {
		out.files = out.files.filter((f) => f !== "npm-shrinkwrap.json");
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
