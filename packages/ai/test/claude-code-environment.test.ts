import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeEnvironment } from "../src/api/claude-code-process.ts";

afterEach(() => vi.unstubAllEnvs());

describe("claudeCodeEnvironment allowlist", () => {
	it("passes CA, identity, XDG, and browser-login variables", () => {
		const passed = {
			NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
			SSL_CERT_FILE: "/etc/ssl/cert.pem",
			SSL_CERT_DIR: "/etc/ssl/certs",
			USER: "ash",
			LOGNAME: "ash",
			DISPLAY: ":0",
			WAYLAND_DISPLAY: "wayland-0",
			XDG_RUNTIME_DIR: "/run/user/1000",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
			BROWSER: "firefox",
			XDG_CONFIG_HOME: "/home/ash/.config",
			XDG_DATA_HOME: "/home/ash/.local/share",
			XDG_CACHE_HOME: "/home/ash/.cache",
			XDG_STATE_HOME: "/home/ash/.local/state",
			TERM: "xterm-256color",
		};
		for (const [name, value] of Object.entries(passed)) vi.stubEnv(name, value);
		expect(claudeCodeEnvironment()).toMatchObject(passed);
	});

	it("still drops credentials, endpoints, config dir, and unlisted variables", () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-secret");
		vi.stubEnv("GITHUB_TOKEN", "ghp-secret");
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/elsewhere");
		vi.stubEnv("NODE_OPTIONS", "--require /evil.js");
		const env = claudeCodeEnvironment();
		expect(Object.keys(env)).not.toEqual(expect.arrayContaining(["OPENAI_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS"]));
		expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
	});

	it("refuses an inherited Anthropic endpoint override", () => {
		vi.stubEnv("ANTHROPIC_BASE_URL", "https://elsewhere.example");
		expect(() => claudeCodeEnvironment()).toThrow("conflicting environment variables");
		expect(claudeCodeEnvironment(undefined, false).ANTHROPIC_BASE_URL).toBeUndefined();
	});
});
