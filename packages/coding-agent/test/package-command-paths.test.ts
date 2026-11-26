import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdateCli } from "../src/cli/update-cli.ts";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, NPM_CLI_PACKAGE, VERSION } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { main } from "../src/main.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	function getNewerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	function extensionPaths(
		packageRoot: string,
		source: string,
		scope: "user" | "project",
		names: string[],
	): ResolvedPaths {
		return {
			extensions: names.map((name) => ({
				path: join(packageRoot, "extensions", name),
				enabled: true,
				metadata: { source, scope, origin: "package", baseDir: packageRoot },
			})),
			skills: [],
			prompts: [],
			themes: [],
		};
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			if (code === undefined || code === null || Number(code) === 0) {
				process.exitCode = undefined;
			} else {
				process.exitCode = code;
			}
			return undefined as never;
		}) as typeof process.exit);
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("skips untrusted project package settings", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:@project/pkg"] }),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses remembered project trust for list", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:@project/pkg"] }),
		);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("overrides remembered trust for list with --no-approve", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:@project/pkg"] }),
		);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--no-approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("approves project trust for list with --approve", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:@project/pkg"] }),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses default project trust for list", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:@project/pkg"] }),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses project_trust extensions for package commands", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:@project/pkg"] }),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["list"], {
					extensionFactories: [
						(pi) => {
							pi.on("project_trust", () => ({ trusted: "yes" }));
						},
					],
				}),
			).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("does not prompt or ask extensions for project trust during update", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const fakeNpmPath = join(tempDir, "fake-project-npm.cjs");
		const recordPath = join(tempDir, "project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		let projectTrustCalled = false;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["update", "--extensions"], {
					extensionFactories: [
						(pi) => {
							pi.on("project_trust", () => {
								projectTrustCalled = true;
								return { trusted: "yes" };
							});
						},
					],
				}),
			).resolves.toBeUndefined();

			expect(projectTrustCalled).toBe(false);
			expect(existsSync(recordPath)).toBe(false);
			expect(process.exitCode).toBe(2);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("rejects extension updates even when project trust is saved", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		const fakeNpmPath = join(tempDir, "fake-trusted-project-npm.cjs");
		const recordPath = join(tempDir, "trusted-project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "--extensions"])).resolves.toBeUndefined();

			expect(existsSync(recordPath)).toBe(false);
			expect(process.exitCode).toBe(2);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("lets trust.json override default project trust", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ packages: ["npm:@project/pkg"] }),
		);
		new ProjectTrustStore(agentDir).set(projectDir, false);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("blocks local package changes when project is untrusted", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), "{}");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "-l", "./local-package"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Project is not trusted. Use --approve to modify local package config.");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("allows local package install to initialize fresh project settings", async () => {
		await main(["install", "-l", packageDir]);

		const settingsPath = join(projectDir, CONFIG_DIR_NAME, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		expect(realpathSync(join(projectDir, CONFIG_DIR_NAME, stored))).toBe(realpathSync(packageDir));
		expect(process.exitCode).toBeUndefined();
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain(`${APP_NAME} install <source> [-l]`);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("rejects model catalog flags on update and explains the refresh command", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await main(["update", "--models"]);
		expect(create).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith("Unknown argument: --models");
		expect(log.mock.calls.flat().join("\n")).toContain("model catalogs (/refresh)");
		expect(process.exitCode).toBe(2);
	});

	it("rejects unsupported update flags even with --self", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		await main(["update", "--models", "--self"]);
		expect(create).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith("Unknown argument: --models");
		expect(process.exitCode).toBe(2);
	});

	it("cycles project package overrides in config local mode", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ packages: ["npm:pi-tools"] }));
		const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: true });
		const resolvedPaths = extensionPaths(join(tempDir, "pkg"), "npm:pi-tools", "user", ["bar.ts"]);
		const selector = new ConfigSelectorComponent(
			{ global: resolvedPaths, project: resolvedPaths },
			settingsManager,
			projectDir,
			agentDir,
			() => {},
			() => {},
			() => {},
			24,
			"project",
		);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, extensions: ["-extensions/bar.ts"] },
		]);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, extensions: ["+extensions/bar.ts"] },
		]);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([]);
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain(
				`Use "${APP_NAME} --help" or "${APP_NAME} install <source> [-l] [--approve|--no-approve]".`,
			);
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain(`Usage: ${APP_NAME} install <source> [-l]`);
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("does not reinstall an already current CLI", async () => {
		const spawn = vi.fn(async () => 0);
		const log = vi.fn();
		const check = vi.fn(async () => ({ current: VERSION, latest: VERSION, newer: false }));
		expect(await handleUpdateCli(["update", "--self"], { published: true, check, spawn, log })).toBe(true);
		expect(check).toHaveBeenCalledWith(expect.objectContaining({ force: true, agentDir }));
		expect(spawn).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(`${APP_NAME} ${VERSION} is up to date.`);
		expect(process.exitCode).toBe(0);
	});

	it("installs the checked public CLI version using global npm settings", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const projectPrefix = join(tempDir, "project-prefix");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ npmCommand: ["npm", "--prefix", globalPrefix] }));
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ npmCommand: ["project-npm", "--prefix", projectPrefix] }),
		);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const version = getNewerPatchVersion();
		const spawn = vi.fn(async () => 0);
		const log = vi.fn();
		const warn = vi.fn();
		expect(
			await handleUpdateCli(["update", "--self"], {
				published: true,
				check: async () => ({ current: VERSION, latest: version, newer: true }),
				spawn,
				log,
				warn,
			}),
		).toBe(true);
		expect(spawn).toHaveBeenCalledExactlyOnceWith("npm", [
			"--prefix",
			globalPrefix,
			"install",
			"-g",
			`${NPM_CLI_PACKAGE}@${version}`,
		]);
		expect(log).toHaveBeenCalledWith(`Updated ${APP_NAME} ${VERSION} → ${version}.`);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${NPM_CLI_PACKAGE}@${version}`));
		expect(process.exitCode).toBe(0);
	});

	it("keeps the public package identity even if registry metadata supplies another name", async () => {
		const version = getNewerPatchVersion();
		const spawn = vi.fn(async () => 0);
		expect(
			await handleUpdateCli(["update"], {
				published: true,
				check: async () => ({ current: VERSION, latest: version, newer: true, packageName: "@other/package" }),
				spawn,
				log: vi.fn(),
				warn: vi.fn(),
			}),
		).toBe(true);
		expect(spawn).toHaveBeenCalledExactlyOnceWith("npm", ["install", "-g", `${NPM_CLI_PACKAGE}@${version}`]);
		expect(process.exitCode).toBe(0);
	});

	it("propagates failed npm installs without reporting a completed update", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ npmCommand: ["pnpm"] }));
		const spawn = vi.fn(async () => 23);
		const log = vi.fn();
		const version = getNewerPatchVersion();
		expect(
			await handleUpdateCli(["update", "--self"], {
				published: true,
				check: async () => ({ current: VERSION, latest: version, newer: true }),
				spawn,
				log,
				warn: vi.fn(),
			}),
		).toBe(true);
		expect(spawn).toHaveBeenCalledExactlyOnceWith("pnpm", ["install", "-g", `${NPM_CLI_PACKAGE}@${version}`]);
		expect(log).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(23);
	});

	it("does not install when the registry check fails", async () => {
		const spawn = vi.fn(async () => 0);
		const error = vi.fn();
		expect(await handleUpdateCli(["update"], { published: true, check: async () => undefined, spawn, error })).toBe(
			true,
		);
		expect(spawn).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith("Could not reach the npm registry to check for updates.");
		expect(process.exitCode).toBe(1);
	});

	it("rejects extension package names on update and preserves configured packages", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Unknown argument: pi-formatter");
			expect(stdout).not.toContain("Updated pi-formatter");
			expect(process.exitCode).toBe(2);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
