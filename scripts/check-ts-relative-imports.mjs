import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

// Fails on relative `.js` specifiers in .ts files, and on imports from coding-agent `core/` into `modes/`
// (core must load without the TUI). The pairs below are the only core-to-modes imports allowed.
const codingAgentSrc = "packages/coding-agent/src";
const themeReason =
	"the theme is shared state: the extension API exposes Theme and ctx.ui.theme in every mode, and the " +
	"resource loader and HTML export read it. It stays in modes/ because user theme files link theme-schema.json by that path";
const allowedCoreToModes = new Map([
	["core/agent-session.ts -> modes/interactive/theme/theme.ts", themeReason],
	["core/resource-loader.ts -> modes/interactive/theme/theme.ts", themeReason],
	["core/extensions/runner.ts -> modes/interactive/theme/theme.ts", themeReason],
	["core/extensions/types.ts -> modes/interactive/theme/theme.ts", themeReason],
	["core/export-html/index.ts -> modes/interactive/theme/theme.ts", themeReason],
	["core/export-html/tool-renderer.ts -> modes/interactive/theme/theme.ts", themeReason],
	[
		"core/agent-session.ts -> modes/interactive/tool-renderers/index.ts",
		"HTML export draws built-in tools with the TUI renderers; exportToHtml imports them lazily",
	],
]);

const ignoredDirectories = new Set([".git", "builtin-extensions", "coverage", "dist", "node_modules"]);
const ignoredRootDirectories = new Set(["codex", "extension-repos", "hermes-agent", "kimi-cli", "pi"]);
const files = [];

function collectTypescriptFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name) && !(directory === "." && ignoredRootDirectories.has(entry.name))) {
				collectTypescriptFiles(join(directory, entry.name));
			}
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(join(directory, entry.name));
		}
	}
}

function isRelativeJavaScriptSpecifier(specifier) {
	return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}

function getImportTypeSpecifier(node) {
	if (!ts.isLiteralTypeNode(node.argument)) return undefined;
	if (!ts.isStringLiteralLike(node.argument.literal)) return undefined;
	return node.argument.literal;
}

const failures = [];
const layerFailures = [];

collectTypescriptFiles(".");

for (const file of files.sort()) {
	const sourceText = readFileSync(file, "utf8");
	const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);

	const fromSrc = relative(codingAgentSrc, file);
	const inCore = fromSrc.startsWith("core/");

	function checkSpecifier(node) {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		if (isRelativeJavaScriptSpecifier(node.text)) failures.push(`${file}:${line + 1}:${character + 1}: ${node.text}`);
		if (!inCore || !/^\.\.?\//.test(node.text)) return;
		const target = relative(codingAgentSrc, join(dirname(file), node.text));
		if (target.startsWith("modes/") && !allowedCoreToModes.has(`${fromSrc} -> ${target}`)) {
			layerFailures.push(`${file}:${line + 1}:${character + 1}: ${node.text}`);
		}
	}

	function visit(node) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			checkSpecifier(node.arguments[0]);
		} else if (ts.isImportTypeNode(node)) {
			const specifier = getImportTypeSpecifier(node);
			if (specifier) checkSpecifier(specifier);
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
}

if (failures.length > 0) {
	console.error("Relative .js imports are not allowed in non-declaration .ts files:");
	for (const failure of failures) console.error(`  ${failure}`);
}
if (layerFailures.length > 0) {
	console.error(
		"coding-agent core/ must not import modes/. Move drawing code to modes/interactive (see tool-renderers/):",
	);
	for (const failure of layerFailures) console.error(`  ${failure}`);
}
if (failures.length > 0 || layerFailures.length > 0) process.exit(1);
