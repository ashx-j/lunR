/**
 * The loaded-resources listing for interactive mode: the [Context], [Skills], [Prompts], [Extensions]
 * and [Themes] sections (shown with --verbose or when forced) and the conflict and error diagnostics
 * shown after startup and /reload. InteractiveMode supplies its container and session through
 * LoadedResourcesHost.
 */

import * as path from "node:path";
import { type Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ExtensionRunner } from "../../core/extensions/index.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { shortenPath } from "../../core/tools/render-utils.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";
import { type ThemeColor, theme } from "./theme/theme.ts";

/** What the listing needs from InteractiveMode, read once per render. */
export interface LoadedResourcesHost {
	readonly session: Pick<AgentSession, "resourceLoader" | "extensionRunner" | "promptTemplates">;
	/** Cleared and refilled on every render. */
	readonly container: Container;
	readonly cwd: string;
	/** --verbose: always show the listing. */
	readonly verbose: boolean;
	/** Whether sections open expanded (verbose, or tool output expanded). */
	readonly expanded: boolean;
}

export interface LoadedResourcesOptions {
	extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
	force?: boolean;
	showDiagnosticsWhenQuiet?: boolean;
}

// A section that switches between its compact and full body with the tool expansion toggle.
class ExpandableText extends Text {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

/** Warnings for extension commands that share a name with a builtin interactive command. */
export function getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
	const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
	return extensionRunner
		.getRegisteredCommands()
		.filter((command) => builtinNames.has(command.name))
		.map((command) => ({
			type: "warning" as const,
			message:
				command.invocationName === command.name
					? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
					: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
			path: command.sourceInfo.path,
		}));
}

function formatExtensionDisplayPath(path: string): string {
	let result = shortenPath(path);
	result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
	return result;
}

function formatContextPath(p: string, cwdPath: string): string {
	const cwd = path.resolve(cwdPath);
	const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
	const relativePath = getCwdRelativePath(absolutePath, cwd);
	if (relativePath !== undefined) {
		return relativePath;
	}

	return shortenPath(absolutePath);
}

/**
 * Get a short path relative to the package root for display.
 */
function getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && isPackageSource(sourceInfo)) {
		const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
		if (
			relativePath &&
			relativePath !== "." &&
			!relativePath.startsWith("..") &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath)
		) {
			return relativePath.replace(/\\/g, "/");
		}
	}

	const source = sourceInfo?.source ?? "";
	const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch && source.startsWith("npm:")) {
		return npmMatch[2];
	}

	const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch && source.startsWith("git:")) {
		return gitMatch[1];
	}

	return shortenPath(fullPath);
}

function getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
	const shortPath = getShortPath(resourcePath, sourceInfo);
	const normalizedPath = shortPath.replace(/\\/g, "/");
	const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
	if (segments.length > 0) {
		return segments[segments.length - 1]!;
	}
	return shortPath;
}

function getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) {
		return source.slice("npm:".length) || source;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		return gitSource.path || source;
	}

	return source;
}

function getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
	if (!isPackageSource(sourceInfo)) {
		return getCompactPathLabel(resourcePath, sourceInfo);
	}

	const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
	if (!sourceLabel) {
		return getCompactPathLabel(resourcePath, sourceInfo);
	}

	const shortPath = getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
	const parsedPath = path.posix.parse(packagePath);

	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
	}

	return `${sourceLabel}:${packagePath}`;
}

function getCompactDisplayPathSegments(resourcePath: string): string[] {
	return shortenPath(resourcePath)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

function getCompactNonPackageExtensionLabel(
	resourcePath: string,
	index: number,
	allPaths: Array<{ path: string; segments: string[] }>,
): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) {
		return getCompactPathLabel(resourcePath);
	}

	for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
		const candidate = segments.slice(-segmentCount).join("/");
		const isUnique = allPaths.every((item, itemIndex) => {
			if (itemIndex === index) {
				return true;
			}
			return item.segments.slice(-segmentCount).join("/") !== candidate;
		});

		if (isUnique) {
			return candidate;
		}
	}

	return segments.join("/");
}

function getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
	const nonPackageExtensions = extensions
		.map((extension) => {
			const segments = getCompactDisplayPathSegments(extension.path);
			const lastSegment = segments[segments.length - 1];
			if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
				segments.pop();
			}
			return {
				path: extension.path,
				sourceInfo: extension.sourceInfo,
				segments,
			};
		})
		.filter((extension) => !isPackageSource(extension.sourceInfo));

	return extensions.map((extension) => {
		if (isPackageSource(extension.sourceInfo)) {
			return getCompactExtensionLabel(extension.path, extension.sourceInfo);
		}

		const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
		if (nonPackageIndex === -1) {
			return getCompactPathLabel(extension.path, extension.sourceInfo);
		}

		return getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
	});
}

function getDisplaySourceInfo(sourceInfo?: SourceInfo): {
	label: string;
	scopeLabel?: string;
	color: "accent" | "muted";
} {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "local") {
		if (scope === "user") {
			return { label: "user", color: "muted" };
		}
		if (scope === "project") {
			return { label: "project", color: "muted" };
		}
		if (scope === "temporary") {
			return { label: "path", scopeLabel: "temp", color: "muted" };
		}
		return { label: "path", color: "muted" };
	}

	if (source === "cli") {
		return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
	}

	const scopeLabel =
		scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
	return { label: source, scopeLabel, color: "accent" };
}

function getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "cli" || scope === "temporary") return "path";
	if (scope === "user") return "user";
	if (scope === "project") return "project";
	return "path";
}

function isPackageSource(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

function buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
	scope: "user" | "project" | "path";
	paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
	packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
}> {
	const groups: Record<
		"user" | "project" | "path",
		{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}
	> = {
		user: { scope: "user", paths: [], packages: new Map() },
		project: { scope: "project", paths: [], packages: new Map() },
		path: { scope: "path", paths: [], packages: new Map() },
	};

	for (const item of items) {
		const groupKey = getScopeGroup(item.sourceInfo);
		const group = groups[groupKey];
		const source = item.sourceInfo?.source ?? "local";

		if (isPackageSource(item.sourceInfo)) {
			const list = group.packages.get(source) ?? [];
			list.push(item);
			group.packages.set(source, list);
		} else {
			group.paths.push(item);
		}
	}

	return [groups.project, groups.user, groups.path].filter(
		(group) => group.paths.length > 0 || group.packages.size > 0,
	);
}

function formatScopeGroups(
	groups: Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}>,
	options: {
		formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
		formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
	},
): string {
	const lines: string[] = [];

	for (const group of groups) {
		lines.push(`  ${theme.fg("accent", group.scope)}`);

		const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
		for (const item of sortedPaths) {
			lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
		}

		const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
		for (const [source, items] of sortedPackages) {
			lines.push(`    ${theme.fg("mdLink", source)}`);
			const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPackagePaths) {
				lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
			}
		}
	}

	return lines.join("\n");
}

function findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
	const exact = sourceInfos.get(p);
	if (exact) return exact;

	let current = p;
	while (current.includes("/")) {
		current = current.substring(0, current.lastIndexOf("/"));
		const parent = sourceInfos.get(current);
		if (parent) return parent;
	}

	return undefined;
}

function formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
	if (sourceInfo) {
		const shortPath = getShortPath(p, sourceInfo);
		const { label, scopeLabel } = getDisplaySourceInfo(sourceInfo);
		const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
		return `${labelText} ${shortPath}`;
	}
	return shortenPath(p);
}

function formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
	const lines: string[] = [];

	// Group collision diagnostics by name
	const collisions = new Map<string, ResourceDiagnostic[]>();
	const otherDiagnostics: ResourceDiagnostic[] = [];

	for (const d of diagnostics) {
		if (d.type === "collision" && d.collision) {
			const list = collisions.get(d.collision.name) ?? [];
			list.push(d);
			collisions.set(d.collision.name, list);
		} else {
			otherDiagnostics.push(d);
		}
	}

	// Format collision diagnostics grouped by name
	for (const [name, collisionList] of collisions) {
		const first = collisionList[0]?.collision;
		if (!first) continue;
		lines.push(theme.fg("warning", `  "${name}" collision:`));
		lines.push(
			theme.fg(
				"dim",
				`    ${theme.fg("success", "✓")} ${formatPathWithSource(first.winnerPath, findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
			),
		);
		for (const d of collisionList) {
			if (d.collision) {
				lines.push(
					theme.fg(
						"dim",
						`    ${theme.fg("warning", "✗")} ${formatPathWithSource(d.collision.loserPath, findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
					),
				);
			}
		}
	}

	for (const d of otherDiagnostics) {
		if (d.path) {
			const formattedPath = formatPathWithSource(d.path, findSourceInfoForPath(d.path, sourceInfos));
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
		} else {
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
		}
	}

	return lines.join("\n");
}

/**
 * Renders the listing into `host.container`. The listing shows only with --verbose or `force`;
 * diagnostics also show with `showDiagnosticsWhenQuiet`.
 */
export function showLoadedResources(host: LoadedResourcesHost, options?: LoadedResourcesOptions): void {
	// Resource rendering is idempotent; chat clears no longer clear this separate container.
	host.container.clear();

	// lunr: startup/reload render nothing by default; the [Context]/[Skills]/etc. listing
	// only appears with --verbose (or an explicit force). Diagnostics still surface below.
	const showListing = options?.force || host.verbose;
	const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
	if (!showListing && !showDiagnostics) {
		return;
	}

	const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
	const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
		const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
		if (options?.sort !== false) {
			labels.sort((a, b) => a.localeCompare(b));
		}
		return theme.fg("dim", `  ${labels.join(", ")}`);
	};
	const addLoadedSection = (
		name: string,
		collapsedBody: string,
		expandedBody = collapsedBody,
		color: ThemeColor = "mdHeading",
	): void => {
		const section = new ExpandableText(
			() => `${sectionHeader(name, color)}\n${collapsedBody}`,
			() => `${sectionHeader(name, color)}\n${expandedBody}`,
			host.expanded,
			0,
			0,
		);
		host.container.addChild(section);
		host.container.addChild(new Spacer(1));
	};

	const skillsResult = host.session.resourceLoader.getSkills();
	const promptsResult = host.session.resourceLoader.getPrompts();
	const themesResult = host.session.resourceLoader.getThemes();
	const extensions =
		options?.extensions ??
		host.session.resourceLoader
			.getExtensions()
			.extensions.filter((extension) => !extension.path.startsWith("<inline:"))
			.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
	const sourceInfos = new Map<string, SourceInfo>();
	for (const extension of extensions) {
		if (extension.sourceInfo) {
			sourceInfos.set(extension.path, extension.sourceInfo);
		}
	}
	for (const skill of skillsResult.skills) {
		if (skill.sourceInfo) {
			sourceInfos.set(skill.filePath, skill.sourceInfo);
		}
	}
	for (const prompt of promptsResult.prompts) {
		if (prompt.sourceInfo) {
			sourceInfos.set(prompt.filePath, prompt.sourceInfo);
		}
	}
	for (const loadedTheme of themesResult.themes) {
		if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
			sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
		}
	}

	if (showListing) {
		const contextFiles = host.session.resourceLoader.getAgentsFiles().agentsFiles;
		if (contextFiles.length > 0) {
			host.container.addChild(new Spacer(1));
			const contextList = contextFiles.map((f) => theme.fg("dim", `  ${shortenPath(f.path)}`)).join("\n");
			const contextCompactList = formatCompactList(
				contextFiles.map((contextFile) => formatContextPath(contextFile.path, host.cwd)),
				{ sort: false },
			);
			addLoadedSection("Context", contextCompactList, contextList);
		}

		const skills = skillsResult.skills;
		if (skills.length > 0) {
			const groups = buildScopeGroups(
				skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
			);
			const skillList = formatScopeGroups(groups, {
				formatPath: (item) => shortenPath(item.path),
				formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
			});
			const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
			addLoadedSection("Skills", skillCompactList, skillList);
		}

		const templates = host.session.promptTemplates;
		if (templates.length > 0) {
			const groups = buildScopeGroups(
				templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
			);
			const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
			const templateList = formatScopeGroups(groups, {
				formatPath: (item) => {
					const template = templateByPath.get(item.path);
					return template ? `/${template.name}` : shortenPath(item.path);
				},
				formatPackagePath: (item) => {
					const template = templateByPath.get(item.path);
					return template ? `/${template.name}` : shortenPath(item.path);
				},
			});
			const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
			addLoadedSection("Prompts", promptCompactList, templateList);
		}

		if (extensions.length > 0) {
			const groups = buildScopeGroups(extensions);
			const extList = formatScopeGroups(groups, {
				formatPath: (item) => formatExtensionDisplayPath(item.path),
				formatPackagePath: (item) => formatExtensionDisplayPath(getShortPath(item.path, item.sourceInfo)),
			});
			const extensionCompactList = formatCompactList(getCompactExtensionLabels(extensions));
			addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
		}

		// Show loaded themes (excluding built-in)
		const loadedThemes = themesResult.themes;
		const customThemes = loadedThemes.filter((t) => t.sourcePath);
		if (customThemes.length > 0) {
			const groups = buildScopeGroups(
				customThemes.map((loadedTheme) => ({
					path: loadedTheme.sourcePath!,
					sourceInfo: loadedTheme.sourceInfo,
				})),
			);
			const themeList = formatScopeGroups(groups, {
				formatPath: (item) => shortenPath(item.path),
				formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
			});
			const themeCompactList = formatCompactList(
				customThemes.map(
					(loadedTheme) =>
						loadedTheme.name ?? getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
				),
			);
			addLoadedSection("Themes", themeCompactList, themeList);
		}
	}

	if (showDiagnostics) {
		const skillDiagnostics = skillsResult.diagnostics;
		if (skillDiagnostics.length > 0) {
			const warningLines = formatDiagnostics(skillDiagnostics, sourceInfos);
			host.container.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
			host.container.addChild(new Spacer(1));
		}

		const promptDiagnostics = promptsResult.diagnostics;
		if (promptDiagnostics.length > 0) {
			const warningLines = formatDiagnostics(promptDiagnostics, sourceInfos);
			host.container.addChild(new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0));
			host.container.addChild(new Spacer(1));
		}

		const extensionDiagnostics: ResourceDiagnostic[] = [];
		const extensionErrors = host.session.resourceLoader.getExtensions().errors;
		if (extensionErrors.length > 0) {
			for (const error of extensionErrors) {
				extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
			}
		}

		const commandDiagnostics = host.session.extensionRunner.getCommandDiagnostics();
		extensionDiagnostics.push(...commandDiagnostics);
		extensionDiagnostics.push(...getBuiltInCommandConflictDiagnostics(host.session.extensionRunner));

		const shortcutDiagnostics = host.session.extensionRunner.getShortcutDiagnostics();
		extensionDiagnostics.push(...shortcutDiagnostics);

		if (extensionDiagnostics.length > 0) {
			const warningLines = formatDiagnostics(extensionDiagnostics, sourceInfos);
			host.container.addChild(new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0));
			host.container.addChild(new Spacer(1));
		}

		const themeDiagnostics = themesResult.diagnostics;
		if (themeDiagnostics.length > 0) {
			const warningLines = formatDiagnostics(themeDiagnostics, sourceInfos);
			host.container.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
			host.container.addChild(new Spacer(1));
		}
	}
}
