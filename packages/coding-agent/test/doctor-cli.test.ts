import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkDefaultModel,
	checkNode,
	checkTerminal,
	collectDoctorChecks,
	formatDoctorReport,
} from "../src/cli/doctor-cli.ts";

describe("lunr doctor", () => {
	let agentDir: string;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		agentDir = join(mkdtempSync(join(tmpdir(), "lunr-doctor-")), "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		rmSync(join(agentDir, ".."), { recursive: true, force: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	it("flags an old Claude subscription record and a stale catalog with their fixes", async () => {
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				anthropic: { type: "external_claude_code", version: 2, manager: "claude-code", command: "/missing/claude" },
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5", browserEnabled: false }),
		);
		const cache = join(agentDir, "official-catalog-cache.json");
		writeFileSync(cache, "{}");
		const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
		utimesSync(cache, old, old);

		const checks = await collectDoctorChecks(agentDir);
		const byLabel = Object.fromEntries(checks.map((check) => [check.label, check]));

		expect(byLabel["Claude subscription"]).toMatchObject({
			status: "fail",
			fix: "Run /login anthropic once to set it up again.",
		});
		expect(byLabel["Model catalog"]).toMatchObject({ status: "warn", detail: "last refreshed 20 days ago" });
		expect(byLabel["Default model"]).toMatchObject({ status: "ok", detail: "anthropic/claude-sonnet-5" });
		expect(byLabel.Browser).toMatchObject({ status: "ok", detail: "off in /settings" });
		expect(formatDoctorReport(checks)).toContain("2 items need attention.");
	});

	it("names catalog Claude models newer than the saved subscription login", async () => {
		const command = join(agentDir, "claude");
		writeFileSync(command, "");
		// The model list a 2.1.263 picker saved, before the 5.5 models existed.
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				anthropic: {
					type: "external_claude_code",
					version: 3,
					manager: "claude-code",
					command,
					models: [
						{ id: "claude-opus-5", route: "claude-opus-5" },
						{ id: "claude-sonnet-5", route: "claude-sonnet-5" },
					],
				},
			}),
		);

		const checks = await collectDoctorChecks(agentDir);

		expect(checks.find((check) => check.label === "Claude subscription")).toMatchObject({
			status: "warn",
			detail: "the saved login predates claude-opus-5-5, claude-sonnet-5-5",
			fix: "Run /login anthropic to refresh the models it offers. Until then, pick one by id, for example /model claude-opus-5-5.",
		});
	});

	it("keeps the Claude account note that the TUI now shows only after a login", async () => {
		const command = join(agentDir, "claude");
		writeFileSync(command, "");
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				anthropic: {
					type: "external_claude_code",
					version: 3,
					manager: "claude-code",
					command,
					models: [
						{ id: "claude-opus-5-5", route: "claude-opus-5-5" },
						{ id: "claude-sonnet-5-5", route: "claude-sonnet-5-5" },
					],
				},
			}),
		);

		const checks = await collectDoctorChecks(agentDir);

		expect(checks.find((check) => check.label === "Claude subscription")).toMatchObject({
			status: "ok",
			note: "Claude Code signs in to your Claude account. Check that account for usage and any extra charges.",
		});
	});

	it("never prints saved API keys", async () => {
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ openai: { type: "api_key", key: "sk-doctor-secret" } }),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ browserEnabled: false }));
		const report = formatDoctorReport(await collectDoctorChecks(agentDir));
		expect(report).toContain("Saved logins: openai");
		expect(report).not.toContain("sk-doctor-secret");
	});

	it("counts env keys and models.json providers as ready and never names a missing /login", async () => {
		const previousKey = process.env.GROQ_API_KEY;
		process.env.GROQ_API_KEY = "gsk-doctor-secret";
		try {
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						mybox: {
							baseUrl: "http://127.0.0.1:9/v1",
							api: "openai-completions",
							apiKey: "local",
							models: [{ id: "small" }],
						},
					},
				}),
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultProvider: "mybox", defaultModel: "small", browserEnabled: false }),
			);
			const byLabel = Object.fromEntries((await collectDoctorChecks(agentDir)).map((check) => [check.label, check]));
			expect(byLabel["Custom providers"]).toMatchObject({ status: "ok", detail: "mybox" });
			expect(byLabel["Environment keys"]?.detail).toContain("groq");
			expect(byLabel["Default model"]).toMatchObject({ status: "ok", detail: "mybox/small" });
			expect(byLabel.Providers).toBeUndefined();
		} finally {
			if (previousKey === undefined) delete process.env.GROQ_API_KEY;
			else process.env.GROQ_API_KEY = previousKey;
		}

		const unknown = checkDefaultModel("gone", "m", [], new Set(["openai"]));
		expect(unknown.fix).not.toContain("/login");
		expect(checkDefaultModel("openai", "m", [], new Set(["openai"])).fix).toContain("/login openai");
	});

	it("requires Node 22.19 or newer", () => {
		expect(checkNode("22.18.0").status).toBe("fail");
		expect(checkNode("22.19.0").status).toBe("ok");
		expect(checkNode("24.1.0").status).toBe("ok");
	});

	it("names the shortcut trap for terminals it recognizes", () => {
		expect(checkTerminal({ WT_SESSION: "1" }, "/docs").fix).toContain("Alt+Enter toggles fullscreen");
		expect(checkTerminal({ TERM_PROGRAM: "vscode" }, "/docs").fix).toContain("/paste-image");
	});
});
